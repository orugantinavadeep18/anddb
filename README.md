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



.
