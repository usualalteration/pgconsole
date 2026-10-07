"""v1/tables - list tables in one schema with row/size/owner metadata.

Parameters: schema (required)
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


def _error_payload(exc):
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


def main(args, ctx=None):
    try:
        data = request_data(args)
        schema = str(data.get("schema") or "").strip()
        if not schema:
            raise _Failure("ValidationError", "Missing required parameter: schema")
        if len(schema) > 128:
            raise _Failure("ValidationError", "Invalid schema name")

        conn = _connect(ctx)
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                SELECT c.relname AS name,
                       n.nspname AS schema,
                       c.reltuples::bigint AS estimated_rows,
                       pg_total_relation_size(c.oid) AS size_bytes,
                       pg_get_userbyid(c.relowner) AS owner,
                       CASE c.relkind
                            WHEN 'r' THEN 'table'
                            WHEN 'p' THEN 'partitioned'
                            ELSE c.relkind::text
                       END AS kind
                  FROM pg_class c
                  JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = %s
                   AND c.relkind IN ('r', 'p')
                 ORDER BY c.relname
                """,
                (schema,),
            )
            rows = cur.fetchall()
        tables = [
            {
                "name": row["name"],
                "schema": row["schema"],
                "kind": row["kind"],
                "estimatedRows": int(row["estimated_rows"]) if row["estimated_rows"] is not None else None,
                "sizeBytes": int(row["size_bytes"]) if row["size_bytes"] is not None else None,
                "owner": row["owner"],
            }
            for row in rows
        ]
        return _ok({"schema": schema, "tables": tables})
    except Exception as exc:
        return _handle(exc)