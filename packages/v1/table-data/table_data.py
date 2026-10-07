"""v1/table-data - paginated, always-LIMITed data preview for one table.

Parameters:
    schema, table (required)
    limit  (default 100, max 1000)
    offset (offset pagination, default 0)
    after  (keyset cursor: JSON array of last-seen primary key values)
"""

import json
import math
import os
import re
from datetime import date, datetime, time as dt_time, timedelta
from decimal import Decimal
from uuid import UUID

import psycopg
from psycopg import sql
from psycopg.pq import TransactionStatus
from psycopg.rows import dict_row

MAX_LIMIT = 1000
MAX_OFFSET = 1_000_000
MAX_VALUE_CHARS = 200_000

_TYPE_DISPLAY = {
    "int2": "smallint",
    "int4": "integer",
    "int8": "bigint",
    "float4": "real",
    "float8": "double precision",
    "bool": "boolean",
    "varchar": "character varying",
    "bpchar": "character",
    "varbit": "bit varying",
    "timestamptz": "timestamp with time zone",
    "timetz": "time with time zone",
}

_REQUEST_IGNORED = {
    "body", "__ow_method", "__ow_headers", "__ow_path", "__ow_body",
    "__ow_query", "POSTGRES_URL",
}


class _Failure(Exception):
    def __init__(self, type_name, message, extra=None):
        super().__init__(message)
        self.type_name = type_name
        self.message = message
        self.extra = dict(extra or {})


def request_data(args):
    data = dict(args) if isinstance(args, dict) else {}
    body = data.get("body")
    if isinstance(body, str):
        try:
            parsed = json.loads(body)
            body = parsed if isinstance(parsed, dict) else {}
        except Exception:
            body = {}
    merged = dict(body) if isinstance(body, dict) else {}
    merged.update({k: v for k, v in data.items() if k not in _REQUEST_IGNORED})
    return merged


def _sanitize(text):
    if not isinstance(text, str):
        return text
    text = re.sub(r"(postgres(?:ql)?(?:\+[^:\s/]*)?://)[^\s'\"]*", r"\1[redacted]", text, flags=re.I)
    text = re.sub(r"(password\s*[=:]\s*)\S+", r"\1[redacted]", text, flags=re.I)
    return text


def _truncate(text, limit=MAX_VALUE_CHARS):
    if len(text) > limit:
        return text[:limit] + "…[truncated]"
    return text


def _jsonable(value):
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, str):
        return _truncate(value)
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (datetime, date, dt_time)):
        return value.isoformat()
    if isinstance(value, timedelta):
        return str(value)
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return _truncate("\\x" + bytes(value).hex())
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_jsonable(v) for v in value]
    return _truncate(str(value))


def _statement_timeout_ms():
    raw = os.environ.get("PG_STATEMENT_TIMEOUT_MS", "")
    try:
        value = int(str(raw).strip())
        if value > 0:
            return value
    except (TypeError, ValueError):
        pass
    return 10_000


def _connect(ctx):
    if not ctx or not hasattr(ctx, "POSTGRESQL"):
        raise _Failure("ConfigurationError", "PostgreSQL is not configured for this endpoint")
    conn = ctx.POSTGRESQL
    if conn is None:
        raise _Failure("ConfigurationError", "PostgreSQL connection is unavailable")
    try:
        if conn.transaction_status != TransactionStatus.IDLE:
            conn.rollback()
    except Exception:
        pass
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute(sql.SQL("SET statement_timeout = {}").format(sql.Literal(_statement_timeout_ms())))
    return conn


def _describe_columns(conn, cur):
    names = []
    codes = []
    for desc in (cur.description or []):
        names.append(desc.name)
        try:
            codes.append(int(desc.type_code))
        except Exception:
            codes.append(0)
    unique = [c for c in dict.fromkeys(codes) if c]
    type_names = {}
    if unique:
        with conn.cursor(row_factory=dict_row) as meta:
            meta.execute(
                """
                SELECT t.oid AS oid, t.typname AS typname, t.typelem AS typelem,
                       e.typname AS elem_name
                FROM pg_type t
                LEFT JOIN pg_type e ON e.oid = t.typelem
                WHERE t.oid = ANY(%s)
                """,
                (unique,),
            )
            for row in meta.fetchall():
                if row["typelem"] and str(row["typname"]).startswith("_"):
                    base = row["elem_name"] or "unknown"
                    type_names[row["oid"]] = f"{_TYPE_DISPLAY.get(base, base)}[]"
                else:
                    base = row["typname"]
                    type_names[row["oid"]] = _TYPE_DISPLAY.get(base, base)
    columns = []
    for name, code in zip(names, codes):
        columns.append({"name": name, "type": type_names.get(code, "unknown") if code else "unknown"})
    return columns


def _error_payload(exc):
    diag = getattr(exc, "diag", None)

    def field(name):
        try:
            value = getattr(diag, name, None) if diag is not None else None
            return _sanitize(value) if isinstance(value, str) else value
        except Exception:
            return None

    message = _sanitize(str(exc)) or field("message_primary") or "Database error"
    payload = {
        "type": type(exc).__name__,
        "message": message,
        "sqlstate": getattr(exc, "sqlstate", None),
        "detail": field("message_detail"),
        "hint": field("message_hint"),
        "position": field("statement_position"),
        "constraint": field("constraint_name"),
        "table": field("table_name"),
        "schema": field("schema_name"),
        "column": field("column_name"),
    }
    return {k: v for k, v in payload.items() if v not in (None, "")}


def _ok(data):
    return {"ok": True, "data": data, "error": None}


def _fail(error):
    return {"ok": False, "data": None, "error": error}


def _handle(exc):
    if isinstance(exc, _Failure):
        return _fail({"type": exc.type_name, "message": _sanitize(exc.message), **exc.extra})
    if isinstance(exc, psycopg.Error):
        return _fail(_error_payload(exc))
    return _fail({"type": type(exc).__name__, "message": _sanitize(str(exc)) or "Unexpected error"})


def _clamp_int(value, default, low, high):
    try:
        parsed = int(str(value).strip())
    except (TypeError, ValueError):
        parsed = default
    return max(low, min(high, parsed))


TABLE_OID_SQL = """
    SELECT c.oid AS oid
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = %s
       AND c.relname = %s
       AND c.relkind IN ('r', 'p')
"""

PRIMARY_KEY_SQL = """
    SELECT a.attname AS name,
           pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type
      FROM pg_constraint con
      CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
     WHERE con.conrelid = %s
       AND con.contype = 'p'
     ORDER BY k.ord
"""


def main(args, ctx=None):
    try:
        data = request_data(args)
        schema = str(data.get("schema") or "").strip()
        table = str(data.get("table") or "").strip()
        if not schema:
            raise _Failure("ValidationError", "Missing required parameter: schema")
        if not table:
            raise _Failure("ValidationError", "Missing required parameter: table")
        if len(schema) > 128 or len(table) > 128:
            raise _Failure("ValidationError", "Invalid identifier")

        limit = _clamp_int(data.get("limit"), 100, 1, MAX_LIMIT)
        offset = _clamp_int(data.get("offset"), 0, 0, MAX_OFFSET)

        after = None
        after_raw = data.get("after")
        if after_raw not in (None, ""):
            if isinstance(after_raw, str):
                try:
                    after_raw = json.loads(after_raw)
                except Exception:
                    raise _Failure("ValidationError", "Parameter 'after' must be a JSON array cursor")
            if not isinstance(after_raw, list):
                raise _Failure("ValidationError", "Parameter 'after' must be a JSON array cursor")
            after = list(after_raw)

        conn = _connect(ctx)
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(TABLE_OID_SQL, (schema, table))
            row = cur.fetchone()
            if not row:
                raise _Failure("NotFoundError", f'Table "{schema}"."{table}" does not exist or is not visible')
            oid = row["oid"]

            cur.execute(PRIMARY_KEY_SQL, (oid,))
            pk_cols = [
                {"name": r["name"], "data_type": r["data_type"]}
                for r in cur.fetchall()
            ]

        pk_names = [c["name"] for c in pk_cols]
        mode = "keyset" if pk_cols else "offset"
        if after is not None and not pk_cols:
            raise _Failure("ValidationError", "Keyset pagination is not available: table has no primary key")
        if after is not None and len(after) != len(pk_cols):
            raise _Failure("ValidationError", "Cursor length does not match the primary key columns")

        # Safe identifier composition via psycopg sql composition.
        query = sql.Composed(
            [
                sql.SQL("SELECT * FROM "),
                sql.Identifier(schema),
                sql.SQL("."),
                sql.Identifier(table),
            ]
        )
        params = []
        if pk_cols:
            idents = [sql.Identifier(c["name"]) for c in pk_cols]
            if after is not None:
                right = [
                    sql.Composed([sql.Placeholder(), sql.SQL("::"), sql.SQL(c["data_type"])])
                    for c in pk_cols
                ]
                query = sql.Composed(
                    [
                        query,
                        sql.SQL(" WHERE ("),
                        sql.SQL(", ").join(idents),
                        sql.SQL(") > ("),
                        sql.SQL(", ").join(right),
                        sql.SQL(")"),
                    ]
                )
                params = list(after)
            query = sql.Composed([query, sql.SQL(" ORDER BY "), sql.SQL(", ").join(idents)])
        # Fetch one extra row so hasMore/nextCursor can be computed without a count query.
        query = sql.Composed([query, sql.SQL(" LIMIT "), sql.Literal(limit + 1)])
        if mode == "offset" and offset > 0:
            query = sql.Composed([query, sql.SQL(" OFFSET "), sql.Literal(offset)])

        query_string = query.as_string(conn)
        with conn.cursor(row_factory=dict_row) as cur:
            if params:
                cur.execute(query_string, tuple(params))
            else:
                cur.execute(query_string)
            fetched = cur.fetchall()
            has_more = len(fetched) > limit
            fetched = fetched[:limit]
            columns = _describe_columns(conn, cur)
            rows = [
                {key: _jsonable(value) for key, value in row.items()}
                for row in fetched
            ]

        next_cursor = None
        if mode == "keyset" and has_more and rows:
            last = fetched[-1]
            next_cursor = [_jsonable(last[name]) for name in pk_names]

        return _ok(
            {
                "schema": schema,
                "table": table,
                "mode": mode,
                "limit": limit,
                "offset": offset if mode == "offset" else None,
                "orderedBy": pk_names,
                "primaryKey": pk_names,
                "columns": columns,
                "rows": rows,
                "rowCount": len(rows),
                "hasMore": has_more,
                "nextCursor": next_cursor,
            }
        )
    except _Failure as exc:
        return _handle(exc)
    except Exception as exc:
        return _handle(exc)