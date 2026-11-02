from __future__ import annotations

import asyncio
import json
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import oracledb
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

APP_DIR = Path(__file__).resolve().parent
HISTORY_DB = APP_DIR.parent / "anydb_history.sqlite3"
RETENTION_DAYS = 7
MAX_QUERY_ROWS = 200

app = FastAPI(title="AnyDB Oracle", version="1.0.0", description="Oracle-only database explorer, SQL workspace and change-impact history.")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5174"
],
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type"],
)

class ConnectionInput(BaseModel):
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(default=1521, ge=1, le=65535)
    service_name: str = Field(min_length=1, max_length=128)
    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=512)
    schema_name: str | None = Field(default=None, alias="schema")

class QueryInput(BaseModel):
    sql: str = Field(min_length=1, max_length=20000)
    confirm_changes: bool = False

class ChangeInput(BaseModel):
    object_name: str = Field(min_length=1, max_length=128)
    change_type: str
    column_name: str | None = Field(default=None, max_length=128)
    constraint_name: str | None = Field(default=None, max_length=128)
    new_data_type: str | None = Field(default=None, max_length=100)

_current_connection: dict[str, Any] | None = None
_current_schema: dict[str, Any] | None = None


def _now() -> datetime:
    return datetime.now(timezone.utc)


@contextmanager
def _db():
    conn = sqlite3.connect(HISTORY_DB)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _init_history() -> None:
    with _db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS analysis_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                title TEXT NOT NULL,
                target TEXT NOT NULL,
                risk TEXT NOT NULL,
                impact_count INTEGER NOT NULL,
                details_json TEXT NOT NULL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_history_created_at ON analysis_history(created_at)")
    _cleanup_history()


def _cleanup_history() -> int:
    cutoff = (_now() - timedelta(days=RETENTION_DAYS)).isoformat()
    with _db() as conn:
        cur = conn.execute("DELETE FROM analysis_history WHERE created_at < ?", (cutoff,))
        return cur.rowcount


def _save_history(title: str, target: str, risk: str, impact_count: int, details: dict[str, Any]) -> int:
    _cleanup_history()
    with _db() as conn:
        cur = conn.execute(
            "INSERT INTO analysis_history(created_at,title,target,risk,impact_count,details_json) VALUES(?,?,?,?,?,?)",
            (_now().isoformat(), title, target, risk, impact_count, json.dumps(details, default=str)),
        )
        return int(cur.lastrowid)


def _connect(cfg: dict[str, Any]):
    dsn = f"{cfg['host']}:{cfg['port']}/{cfg['service_name']}"
    return oracledb.connect(user=cfg["username"], password=cfg["password"], dsn=dsn)


def _public_schema(payload: ConnectionInput) -> dict[str, Any]:
    with _connect(payload.model_dump()) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT table_name FROM user_tables ORDER BY table_name")
            table_names = [row[0] for row in cur.fetchall()]
            tables = []
            for table_name in table_names:
                cur.execute("""
                    SELECT column_name, data_type, data_length, data_precision, data_scale, nullable
                    FROM user_tab_columns WHERE table_name = :name ORDER BY column_id
                """, name=table_name)
                columns = []
                for name, data_type, length, precision, scale, nullable in cur.fetchall():
                    display_type = data_type
                    if data_type in ("VARCHAR2", "CHAR", "NVARCHAR2", "NCHAR", "RAW"):
                        display_type = f"{data_type}({length})"
                    elif data_type == "NUMBER" and precision is not None:
                        display_type = f"NUMBER({precision},{scale or 0})"
                    columns.append({"name": name, "data_type": display_type, "nullable": nullable})
                tables.append({"name": table_name, "columns": columns})

            cur.execute("""
                SELECT c.table_name, c.constraint_name, c.constraint_type, cc.column_name,
                       r.table_name, rcc.column_name, c.search_condition
                FROM user_constraints c
                LEFT JOIN user_cons_columns cc ON c.constraint_name = cc.constraint_name AND c.table_name = cc.table_name
                LEFT JOIN user_constraints r ON c.r_constraint_name = r.constraint_name
                LEFT JOIN user_cons_columns rcc ON r.constraint_name = rcc.constraint_name
                    AND r.table_name = rcc.table_name AND rcc.position = cc.position
                WHERE c.constraint_type IN ('P','R','U','C')
                ORDER BY c.table_name, c.constraint_name, cc.position
            """)
            grouped: dict[tuple[str, str, str], dict[str, Any]] = {}
            for table, name, ctype, column, ref_table, ref_column, condition in cur.fetchall():
                key = (table, name, ctype)
                if key not in grouped:
                    grouped[key] = {"table_name": table, "name": name, "type": ctype, "columns": [],
                                    "references": None, "condition": str(condition) if condition else None}
                if column and column not in grouped[key]["columns"]:
                    grouped[key]["columns"].append(column)
                if ref_table:
                    grouped[key]["references"] = f"{ref_table}.{ref_column}" if ref_column else ref_table
            constraints = list(grouped.values())

            cur.execute("SELECT view_name, text FROM user_views ORDER BY view_name")
            views = [{"name": row[0], "text": str(row[1] or "")[:4000]} for row in cur.fetchall()]
            cur.execute("SELECT name, type, referenced_name, referenced_type FROM user_dependencies ORDER BY name, referenced_name")
            dependencies = [{"name": r[0], "type": r[1], "referenced_name": r[2], "referenced_type": r[3]} for r in cur.fetchall()]
    return {"owner": (payload.schema_name or payload.username).upper(), "tables": tables,
            "constraints": constraints, "views": views, "dependencies": dependencies}


_cleanup_task: asyncio.Task | None = None


async def _periodic_cleanup() -> None:
    while True:
        await asyncio.sleep(3600)
        _cleanup_history()


@app.on_event("startup")
async def startup() -> None:
    global _cleanup_task
    _init_history()
    _cleanup_task = asyncio.create_task(_periodic_cleanup())


@app.on_event("shutdown")
async def shutdown() -> None:
    global _cleanup_task
    if _cleanup_task is not None:
        _cleanup_task.cancel()
        try:
            await _cleanup_task
        except asyncio.CancelledError:
            pass
        _cleanup_task = None


@app.get("/api/health")
def health():
    _init_history()
    return {"status": "ok", "service": "AnyDB Oracle", "database_support": ["Oracle"], "history_retention_days": RETENTION_DAYS}


@app.post("/api/oracle/connect")
def connect_oracle(payload: ConnectionInput):
    global _current_connection, _current_schema
    try:
        schema = _public_schema(payload)
        _current_connection = payload.model_dump(by_alias=True)
        _current_schema = schema
        return {"connected": True, "username": payload.username.upper(), "schema": schema}
    except Exception as exc:
        _current_connection = None
        _current_schema = None
        raise HTTPException(status_code=400, detail=f"Oracle connection or metadata discovery failed ({type(exc).__name__}). Check host, service, username, password, and grants.")


@app.post("/api/oracle/test")
def test_oracle(payload: ConnectionInput):
    try:
        with _connect(payload.model_dump()) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT SYS_CONTEXT('USERENV', 'SESSION_USER') FROM dual")
                user = cur.fetchone()[0]
        return {"connected": True, "username": user, "message": "Oracle connection successful."}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Oracle connection failed ({type(exc).__name__}). Check the connection details and service name.")


@app.get("/api/oracle/schema")
def get_schema():
    if _current_schema is None:
        raise HTTPException(status_code=409, detail="Connect to Oracle first.")
    return _current_schema


@app.post("/api/oracle/refresh")
def refresh_schema():
    global _current_schema
    if _current_connection is None:
        raise HTTPException(status_code=409, detail="Connect to Oracle first.")
    try:
        payload = ConnectionInput.model_validate(_current_connection)
        _current_schema = _public_schema(payload)
        return _current_schema
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not refresh Oracle metadata ({type(exc).__name__}).")


@app.post("/api/oracle/query")
def run_query(payload: QueryInput):
    if _current_connection is None:
        raise HTTPException(status_code=409, detail="Connect to Oracle before running SQL.")
    sql = payload.sql.strip()
    if sql.endswith(";"):
        sql = sql[:-1].rstrip()
    if not sql or ";" in sql:
        raise HTTPException(status_code=400, detail="Run one SQL statement at a time; remove internal or trailing extra statements.")
    # This UI deliberately supports queries and row DML, not DDL or PL/SQL execution.
    match = re.match(r"^([A-Za-z]+)\b", sql)
    statement = match.group(1).upper() if match else ""
    if statement not in {"SELECT", "INSERT", "UPDATE", "DELETE"}:
        raise HTTPException(status_code=400, detail="Allowed statements: SELECT, INSERT, UPDATE, DELETE. DDL, CTEs, and PL/SQL are disabled in this version.")
    is_dml = statement in {"INSERT", "UPDATE", "DELETE"}
    if is_dml and not payload.confirm_changes:
        raise HTTPException(status_code=400, detail="This statement changes data. Confirm the change in the UI before execution.")
       
    try:
        with _connect(_current_connection) as conn:
            with conn.cursor() as cur:
                cur.execute(sql)

                if statement == "SELECT":
                    columns = [d[0] for d in (cur.description or [])]
                    rows = cur.fetchmany(MAX_QUERY_ROWS + 1)
                    truncated = len(rows) > MAX_QUERY_ROWS
                    rows = rows[:MAX_QUERY_ROWS]

                    result_rows = [
                        [str(value) if value is not None else None for value in row]
                        for row in rows
                    ]

                    return {
                        "statement": statement,
                        "columns": columns,
                        "rows": result_rows,
                        "row_count": len(result_rows),
                        "truncated": truncated,
                        "max_rows": MAX_QUERY_ROWS
                    }

                affected = cur.rowcount

            if is_dml:
                conn.commit()

        _save_history(
            f"SQL {statement}",
            "Oracle SQL workspace",
            "INFO",
            0,
            {
                "kind": "sql",
                "statement_type": statement,
                "rows_affected": affected,
                "note": "SQL text is not stored in history."
            }
        )

        return {
            "statement": statement,
            "rows_affected": affected,
            "committed": True,
            "message": (
                f"{statement} completed and committed. "
                "Refresh the schema or rerun SELECT to verify."
            )
        }

    except HTTPException:
        raise

    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Oracle rejected the SQL ({type(exc).__name__}). "
                   "Check syntax, privileges, and data constraints."
        )

def _analyze(schema: dict[str, Any], payload: ChangeInput) -> dict[str, Any]:
    change_type = payload.change_type.upper()
    if change_type not in {"DROP_COLUMN", "MODIFY_DATATYPE", "DROP_CONSTRAINT"}:
        raise HTTPException(status_code=400, detail="Choose DROP_COLUMN, MODIFY_DATATYPE, or DROP_CONSTRAINT.")
    obj = payload.object_name.upper()
    column = payload.column_name.upper() if payload.column_name else None
    constraint_name = payload.constraint_name.upper() if payload.constraint_name else None
    table = next((t for t in schema["tables"] if t["name"] == obj), None)
    if table is None:
        raise HTTPException(status_code=404, detail=f"Table {obj} was not found in the connected schema.")
    if change_type in {"DROP_COLUMN", "MODIFY_DATATYPE"}:
        if not column or not any(c["name"] == column for c in table["columns"]):
            raise HTTPException(status_code=404, detail=f"Column {column or '(not supplied)'} was not found in {obj}.")
    if change_type == "DROP_CONSTRAINT":
        if not constraint_name or not any(c["name"] == constraint_name and c["table_name"] == obj for c in schema["constraints"]):
            raise HTTPException(status_code=404, detail=f"Constraint {constraint_name or '(not supplied)'} was not found on {obj}.")

    impacts: list[dict[str, str]] = []
    if change_type == "DROP_COLUMN":
        for constraint in schema["constraints"]:
            if constraint["table_name"] == obj and column in constraint["columns"]:
                impacts.append({"object": constraint["name"], "object_type": "CONSTRAINT", "severity": "HIGH",
                                "reason": f"Constraint {constraint['name']} uses {obj}.{column}.", "evidence": "Oracle constraint-column metadata."})
            reference = constraint.get("references") or ""
            if reference.startswith(obj + ".") and reference.endswith("." + column):
                impacts.append({"object": constraint["name"], "object_type": "CONSTRAINT", "severity": "HIGH",
                                "reason": f"Constraint {constraint['name']} references {obj}.{column}.", "evidence": "Oracle foreign-key metadata."})
        for dep in schema["dependencies"]:
            if dep["referenced_name"] == obj:
                view = next((v for v in schema["views"] if v["name"] == dep["name"]), None)
                if view and re.search(rf"\b{re.escape(column or '')}\b", view["text"], re.IGNORECASE):
                    impacts.append({"object": dep["name"], "object_type": dep["type"], "severity": "HIGH",
                                    "reason": f"View or dependent object {dep['name']} may use {obj}.{column}.",
                                    "evidence": "Oracle dependency metadata and available view text."})
    elif change_type == "MODIFY_DATATYPE":
        for constraint in schema["constraints"]:
            if constraint["table_name"] == obj and column in constraint["columns"]:
                impacts.append({"object": constraint["name"], "object_type": "CONSTRAINT", "severity": "MEDIUM",
                                "reason": f"Changing {obj}.{column} may affect constraint {constraint['name']}.", "evidence": "Oracle constraint-column metadata."})
        impacts.append({"object": obj, "object_type": "TABLE", "severity": "MEDIUM",
                        "reason": f"Changing {obj}.{column} to {payload.new_data_type or 'an unspecified datatype'} may affect stored values and dependent SQL.",
                        "evidence": "Proposed change only; conversion was not executed."})
    else:
        impacts.append({"object": constraint_name or "", "object_type": "CONSTRAINT", "severity": "MEDIUM",
                        "reason": f"Dropping {constraint_name} may weaken data integrity or permit invalid rows.", "evidence": "Oracle constraint metadata."})

    high = sum(1 for item in impacts if item["severity"] == "HIGH")
    risk = "CRITICAL" if high >= 3 else "HIGH" if high else "MEDIUM" if impacts else "LOW"
    return {"target": {"owner": schema["owner"], "object": obj, "column": column,
                        "constraint": constraint_name, "change_type": change_type, "new_data_type": payload.new_data_type},
            "risk": risk, "impact_count": len(impacts), "impacts": impacts,
            "recommended_tests": ["Review every listed dependency before approving the change.",
                                  "Test the proposed DDL in a separate test schema first.",
                                  "Check existing data compatibility and referential integrity.",
                                  "Re-test views, application queries and dependent procedures."],
            "limitations": ["This is a metadata-based estimate, not a guarantee of safety.",
                            "Dynamic SQL, external application code, other schemas and inaccessible objects may not be discoverable.",
                            "AnyDB does not execute the proposed schema change."]}


@app.post("/api/analyze")
def analyze_change(payload: ChangeInput):
    if _current_schema is None:
        raise HTTPException(status_code=409, detail="Connect to Oracle and load schema metadata before analyzing.")
    result = _analyze(_current_schema, payload)
    target = result["target"]
    title = f"{target['change_type']} {target['object']}"
    if target.get("column"):
        title += f".{target['column']}"
    if target.get("constraint"):
        title += f" / {target['constraint']}"
    result["history_id"] = _save_history(title, f"{target['owner']}.{target['object']}", result["risk"], result["impact_count"], result)
    return result


@app.get("/api/history")
def get_history():
    _cleanup_history()
    with _db() as conn:
        rows = conn.execute("SELECT id,created_at,title,target,risk,impact_count,details_json FROM analysis_history ORDER BY id DESC LIMIT 200").fetchall()
    items = []
    for row in rows:
        item = dict(row)
        item["details"] = json.loads(item.pop("details_json"))
        items.append(item)
    return {"items": items, "retention_days": RETENTION_DAYS}


@app.delete("/api/history/{history_id}")
def delete_history(history_id: int):
    with _db() as conn:
        cur = conn.execute("DELETE FROM analysis_history WHERE id = ?", (history_id,))
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="History item was not found.")
    return {"deleted": True, "id": history_id}


@app.post("/api/history/cleanup")
def cleanup_history():
    deleted = _cleanup_history()
    return {"deleted": deleted, "retention_days": RETENTION_DAYS}
