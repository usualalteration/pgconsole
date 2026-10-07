# PostgreSQL Console

A focused PostgreSQL client with exactly two capabilities:

1. **Table Explorer** — browse schemas and tables visible to the configured database
   user, and inspect each table's data, columns, indexes, constraints, foreign keys
   and reconstructed DDL.
2. **SQL Query Workspace** — a Monaco-based editor with PostgreSQL highlighting
   (`Ctrl/Cmd+Enter` runs the selection or the whole editor), formatting, and a
   results grid with explicit NULL display, JSON/JSONB rendering, bytea previews
   and copy support for cells, rows and whole result sets.

## Architecture

```text
React UI (src/)
   |
   | HTTP  (relative /api/my/v1/...)
   v
Nuvolaris / OpenServerless Python actions (packages/v1/)
   |
   | psycopg 3  (ctx.POSTGRESQL)
   v
PostgreSQL
```

### Actions

| Endpoint                  | Purpose                                              |
| ------------------------- | ---------------------------------------------------- |
| `GET /api/my/v1/schemas`  | Schemas visible to the configured user              |
| `GET /api/my/v1/tables`   | Tables in one schema with rows/size/owner metadata  |
| `GET /api/my/v1/table-details` | Columns, indexes, constraints, foreign keys, DDL |
| `GET /api/my/v1/table-data`   | Bounded, paginated data preview (LIMIT enforced; keyset pagination when a primary key exists, controlled OFFSET/LIMIT otherwise) |
| `POST /api/my/v1/query`  | Executes submitted SQL as the single configured user |

## Security model

- Connection configuration lives only in the backend (platform-managed
  PostgreSQL binding). No credentials or connection strings ever reach React.
- All queries run with the natural permissions of the configured PostgreSQL
  user; no privilege elevation, no reconnecting as another account.
- Role/user management and identity switching (`CREATE/ALTER/DROP USER|ROLE`,
  `SET ROLE`, `RESET ROLE`, `SET SESSION AUTHORIZATION`, `set_config('role', …)`,
  `DISCARD ALL`, `RESET ALL`, `ALTER SYSTEM`) are rejected by the backend before
  execution.
- A server-side statement timeout (default 10s) bounds every statement and
  cannot be overridden by submitted SQL.
- Identifiers are composed with psycopg `sql.Identifier` and values are always
  bound parameters; query results are capped (rows and payload size).

## Local checks

- Backend action checker: `check_openserverless_actions.sh .`
- Splitter/blocklist unit tests: `python3 tests/query/test_splitter.py`
- Frontend: `npm run lint`, `npm run build`