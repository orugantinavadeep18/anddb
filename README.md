# AnyDB — Oracle Edition

A local-first Oracle database workspace with a minimal interface. This version intentionally supports **Oracle Database only**.

## Features in this version

- Connect to an Oracle service and inspect tables, columns, and constraints.
- Refresh schema metadata after database changes.
- Run one SQL statement at a time: `SELECT`, `INSERT`, `UPDATE`, or `DELETE`.
- SELECT results are capped at 200 rows per request.
- DML requires an in-app confirmation and is committed on successful execution. Review every statement carefully before confirming.
- Analyze proposed `DROP COLUMN`, `MODIFY DATATYPE`, and `DROP CONSTRAINT` changes without executing DDL.
- Store impact reports and data-changing SQL activity metadata in a local SQLite history database.
- Automatically remove history older than 7 days. SQL text and database passwords are not stored in history.

## Requirements

- Python 3.10+
- Node.js and npm
- Oracle Database reachable from this computer (for your Docker setup: usually `localhost`, port `1521`, service `FREEPDB1`)

No paid API is required. The history database is created automatically at `backend/anydb_history.sqlite3`.

## Start on Windows

### 1. Start Oracle

```bat
docker start oracle26ai
```

### 2. Start the backend in a Command Prompt

```bat
cd C:\Users\rahul\Downloads\CIDB-starter\change-impact-db\backend
.venv\Scripts\activate
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload
```

If you do not have a `.venv` folder, create it first with `py -m venv .venv`, then activate it. If your environment is already active, do not activate it again.

Backend: `http://127.0.0.1:8000`  
API docs: `http://127.0.0.1:8000/docs`

### 3. Start the frontend in a second Command Prompt

```bat
cd C:\Users\rahul\Downloads\CIDB-starter\change-impact-db\frontend
npm install
npm run dev
```

Open the local URL printed by Vite, usually `http://localhost:5173`.

## Connect to your local HR schema

Use host `localhost`, port `1521`, service `FREEPDB1`, username `HR`, and the password you set when installing the sample HR schema. Metadata discovery is for the schema owned by the connected Oracle user; connect as the schema owner for the expected results.

## Important safety notes

- The SQL workspace is intended for **local development**, not direct exposure to the public internet. Do not expose this backend or Oracle port publicly.
- `INSERT`, `UPDATE`, and `DELETE` are committed immediately after successful execution. The UI asks for confirmation, but that is not a substitute for checking the SQL and maintaining backups.
- `DROP`, `ALTER`, `TRUNCATE`, PL/SQL blocks, and multi-statement submissions are disabled in the SQL workspace. Impact analysis is a separate, non-executing operation.
- Connect using a least-privilege Oracle account. A read-only account is safer for schema analysis; DML requires appropriate write privileges.
- The current connection is held in backend memory for this local single-user prototype. Restarting the backend clears the active connection. Do not use this design for a multi-user or public deployment without authentication, per-user connection isolation, secret handling, and authorization controls.
- Impact analysis is an estimate based on metadata visible to the connected user. It cannot guarantee that a proposed schema change is safe, especially when external application code or dynamic SQL is involved.
