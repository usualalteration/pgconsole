"""v1/schemas - list PostgreSQL schemas visible to the configured application user.

Response envelope:
    {"ok": true, "data": {...}, "error": null}
    {"ok": false, "data": null, "error": {"type": ..., "message": ..., ...}}
"""

import json
import math
import os
import re
import time
from datetime import date, datetime, time as dt_time, timedelta
from decimal import Decimal
from uuid import UUID

import psycopg
from psycopg import sql
from psycopg.pq import TransactionStatus
from psycopg.rows import dict_row

MAX_RESULT_ROWS = 1000
MAX_VALUE_CHARS = 200_000
INTERNAL_SCHEMA_NAMES = ("pg_catalog", "information_schema")

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
    """Application-level failure mapped to the error envelope."""

    def __init__(self, type_name, message, extra=None):
        super().__init__(message)
        self.type_name = type_name
        self.message = message
        self.extra = dict(extra or {})


def request_data(args):
    """Merge OpenWhisk query params, JSON body fields and top-level args."""
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
    """Redact connection strings and passwords from any error text."""
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
    """Convert PostgreSQL/Python values into JSON-safe values (psycopg 3 row values)."""
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
    """Return the platform-provided psycopg connection with a session statement timeout."""
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
    """Return [{name, type}] for a cursor result using pg_type."""
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
    """Build the error envelope body from a psycopg exception with safe diagnostics."""
    diag = getattr(exc, "diag", None)

    def field(name):
        try:
            value = getattr(diag, name, None) if diag is not None else None
            return _sanitize(value) if isinstance(value, str) else value
        except Exception:
            return None

    message = _sanitize(str(exc)) or field("message_primary") or "Database error"
    statement_index = getattr(exc, "statement_index", None)
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
    if statement_index is not None:
        payload["statementIndex"] = statement_index
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


def _is_internal_schema(name):
    return name in INTERNAL_SCHEMA_NAMES or name.startswith("pg_")


def main(args, ctx=None):
    try:
        conn = _connect(ctx)
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                SELECT current_database() AS database,
                       current_user AS username,
                       current_setting('server_version') AS server_version
                """
            )
            info = cur.fetchone()
            cur.execute(
                """
                SELECT n.nspname AS name,
                       pg_get_userbyid(n.nspowner) AS owner,
                       (SELECT count(*)
                          FROM pg_class c
                         WHERE c.relnamespace = n.oid
                           AND c.relkind IN ('r', 'p')) AS table_count
                  FROM pg_namespace n
                 WHERE has_schema_privilege(n.oid, 'USAGE')
                   AND n.nspname !~ '^pg_(temp|toast)'
                 ORDER BY n.nspname
                """
            )
            rows = cur.fetchall()
        schemas = [
            {
                "name": row["name"],
                "internal": _is_internal_schema(row["name"]),
                "owner": row["owner"],
                "tableCount": int(row["table_count"] or 0),
            }
            for row in rows
        ]
        return _ok(
            {
                "database": info["database"],
                "user": info["username"],
                "serverVersion": info["server_version"],
                "schemas": schemas,
            }
        )
    except Exception as exc:
        return _handle(exc)