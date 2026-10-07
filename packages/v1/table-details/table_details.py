"""v1/table-details - columns, indexes, constraints, foreign keys and DDL for one table.

Parameters: schema, table (required)
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

MAX_VALUE_CHARS = 200_000

_REQUEST_IGNORED = {
    "body", "__ow_method", "__ow_headers", "__ow_path", "__ow_body",
    "__ow_query", "POSTGRES_URL",
}

FK_ACTIONS = {
    "a": "NO ACTION",
    "r": "RESTRICT",
    "c": "CASCADE",
    "n": "SET NULL",
    "d": "SET DEFAULT",
}

CONSTRAINT_KINDS = {
    "p": "PRIMARY KEY",
    "u": "UNIQUE",
    "c": "CHECK",
    "x": "EXCLUSION",
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


def _quote_ident(name):
    return '"' + str(name).replace('"', '""') + '"'


def _quote_literal(text):
    return "'" + str(text).replace("'", "''") + "'"


TABLE_META_SQL = """
    SELECT c.oid AS oid,
           CASE c.relkind
                WHEN 'r' THEN 'table'
                WHEN 'p' THEN 'partitioned'
                ELSE c.relkind::text
           END AS kind,
           c.reltuples::bigint AS estimated_rows,
           pg_total_relation_size(c.oid) AS size_bytes,
           pg_get_userbyid(c.relowner) AS owner,
           c.relpersistence AS persistence,
           obj_description(c.oid, 'pg_class') AS comment,
           pg_get_partkeydef(c.oid) AS partition_key
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = %s
       AND c.relname = %s
       AND c.relkind IN ('r', 'p')
"""

COLUMNS_SQL = """
    SELECT a.attname AS name,
           a.attnum AS position,
           pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
           a.attnotnull AS not_null,
           a.attidentity AS identity_kind,
           a.attgenerated AS generated_kind,
           pg_get_expr(ad.adbin, ad.adrelid) AS default_expr,
           col_description(a.attrelid, a.attnum) AS comment,
           (SELECT co.collname
              FROM pg_collation co
             WHERE co.oid = a.attcollation
               AND a.attcollation <> t.typcollation) AS collation
      FROM pg_attribute a
      JOIN pg_type t ON t.oid = a.atttypid
      LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
     WHERE a.attrelid = %s
       AND a.attnum > 0
       AND NOT a.attisdropped
     ORDER BY a.attnum
"""

CONSTRAINTS_SQL = """
    SELECT con.conname AS name,
           con.contype AS kind,
           pg_get_constraintdef(con.oid, true) AS definition,
           con.convalidated AS validated,
           (SELECT array_agg(pa.attname ORDER BY k.ord)
              FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute pa
                ON pa.attrelid = con.conrelid AND pa.attnum = k.attnum) AS columns,
           rn.nspname AS ref_schema,
           rc.relname AS ref_table,
           (SELECT array_agg(pa.attname ORDER BY k.ord)
              FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute pa
                ON pa.attrelid = con.confrelid AND pa.attnum = k.attnum) AS ref_columns,
           con.confupdtype AS on_update_code,
           con.confdeltype AS on_delete_code
      FROM pg_constraint con
      LEFT JOIN pg_class rc ON rc.oid = con.confrelid
      LEFT JOIN pg_namespace rn ON rn.oid = rc.relnamespace
     WHERE con.conrelid = %s
     ORDER BY con.conname
"""

INDEXES_SQL = """
    SELECT ic.relname AS name,
           am.amname AS method,
           ix.indisunique AS is_unique,
           ix.indisprimary AS is_primary,
           ix.indisvalid AS is_valid,
           pg_get_indexdef(ix.indexrelid) AS definition,
           con.conname AS constraint_name,
           (SELECT array_agg(pg_get_indexdef(ix.indexrelid, k.n, true) ORDER BY k.n)
              FROM generate_series(1, ix.indnkeyatts) AS k(n)) AS columns
      FROM pg_index ix
      JOIN pg_class ic ON ic.oid = ix.indexrelid
      JOIN pg_am am ON am.oid = ic.relam
      LEFT JOIN pg_constraint con
             ON con.conindid = ix.indexrelid
            AND con.conrelid = ix.indrelid
            AND con.contype IN ('p', 'u', 'x')
     WHERE ix.indrelid = %s
     ORDER BY ic.relname
"""


def _build_ddl(schema, table, meta, columns, constraints, foreign_keys, indexes):
    """Reconstruct an approximate CREATE TABLE script from catalog metadata."""
    q = _quote_ident
    qualified = f"{q(schema)}.{q(table)}"
    out = []
    out.append("-- DDL reconstructed from PostgreSQL catalog metadata (approximate)")
    prefix = "CREATE UNLOGGED TABLE " if meta.get("persistence") == "u" else "CREATE TABLE "
    out.append(prefix + qualified + " (")

    body = []
    for col in columns:
        part = f"  {q(col['name'])} {col['type']}"
        if col.get("generated") == "STORED" and col.get("default"):
            part += f" GENERATED ALWAYS AS {col['default']} STORED"
        elif col.get("identity"):
            mode = "ALWAYS" if col.get("identity") == "ALWAYS" else "BY DEFAULT"
            part += f" GENERATED {mode} AS IDENTITY"
        elif col.get("default"):
            part += f" DEFAULT {col['default']}"
        if col.get("collation"):
            part += f" COLLATE {q(col['collation'])}"
        if not col.get("nullable", True):
            part += " NOT NULL"
        body.append(part)

    for cst in constraints:
        body.append(f"  CONSTRAINT {q(cst['name'])} {cst['definition']}")

    out.append(",\n".join(body))
    tail = ")"
    if meta.get("partitionKey"):
        tail += f"\nPARTITION BY {meta['partitionKey']}"
    out.append(tail + ";")

    if meta.get("owner"):
        out.append("")
        out.append(f"ALTER TABLE {qualified} OWNER TO {q(meta['owner'])};")

    for idx in indexes:
        if idx.get("constraintName"):
            continue
        out.append(idx["definition"] + ";")

    if meta.get("comment"):
        out.append("")
        out.append(f"COMMENT ON TABLE {qualified} IS {_quote_literal(meta['comment'])};")

    col_comments = [c for c in columns if c.get("comment")]
    if col_comments:
        out.append("")
        for col in col_comments:
            out.append(f"COMMENT ON COLUMN {qualified}.{q(col['name'])} IS {_quote_literal(col['comment'])};")

    if foreign_keys:
        out.append("")
        for fk in foreign_keys:
            out.append(f"ALTER TABLE {qualified} ADD CONSTRAINT {q(fk['name'])} {fk['definition']};")

    return "\n".join(out)


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

        conn = _connect(ctx)
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(TABLE_META_SQL, (schema, table))
            meta_row = cur.fetchone()
            if not meta_row:
                raise _Failure("NotFoundError", f'Table "{schema}"."{table}" does not exist or is not visible')
            oid = meta_row["oid"]

            cur.execute(COLUMNS_SQL, (oid,))
            column_rows = cur.fetchall()
            cur.execute(CONSTRAINTS_SQL, (oid,))
            constraint_rows = cur.fetchall()
            cur.execute(INDEXES_SQL, (oid,))
            index_rows = cur.fetchall()

        columns = [
            {
                "name": row["name"],
                "position": int(row["position"]),
                "type": row["data_type"],
                "nullable": not row["not_null"],
                "default": row["default_expr"],
                "identity": ("ALWAYS" if row["identity_kind"] == "a" else "BY DEFAULT") if row["identity_kind"] else None,
                "generated": "STORED" if row["generated_kind"] == "s" else None,
                "collation": row["collation"],
                "comment": row["comment"],
            }
            for row in column_rows
        ]

        constraints = []
        foreign_keys = []
        primary_key = []
        for row in constraint_rows:
            kind = row["kind"]
            cols = [str(c) for c in (row["columns"] or [])]
            if kind == "p":
                primary_key = cols
                constraints.append(
                    {
                        "name": row["name"],
                        "kind": kind,
                        "kindLabel": CONSTRAINT_KINDS.get(kind, kind),
                        "definition": row["definition"],
                        "validated": bool(row["validated"]),
                        "columns": cols,
                    }
                )
            elif kind == "f":
                foreign_keys.append(
                    {
                        "name": row["name"],
                        "columns": cols,
                        "refSchema": row["ref_schema"],
                        "refTable": row["ref_table"],
                        "refColumns": [str(c) for c in (row["ref_columns"] or [])],
                        "onUpdate": FK_ACTIONS.get(row["on_update_code"], row["on_update_code"]),
                        "onDelete": FK_ACTIONS.get(row["on_delete_code"], row["on_delete_code"]),
                        "definition": row["definition"],
                    }
                )
            elif kind in CONSTRAINT_KINDS:
                constraints.append(
                    {
                        "name": row["name"],
                        "kind": kind,
                        "kindLabel": CONSTRAINT_KINDS.get(kind, kind),
                        "definition": row["definition"],
                        "validated": bool(row["validated"]),
                        "columns": cols,
                    }
                )

        indexes = [
            {
                "name": row["name"],
                "method": row["method"],
                "unique": bool(row["is_unique"]),
                "primary": bool(row["is_primary"]),
                "valid": bool(row["is_valid"]),
                "columns": [str(c) for c in (row["columns"] or [])],
                "definition": row["definition"],
                "constraintName": row["constraint_name"],
            }
            for row in index_rows
        ]

        meta = {
            "schema": schema,
            "name": table,
            "kind": meta_row["kind"],
            "owner": meta_row["owner"],
            "estimatedRows": int(meta_row["estimated_rows"]) if meta_row["estimated_rows"] is not None else None,
            "sizeBytes": int(meta_row["size_bytes"]) if meta_row["size_bytes"] is not None else None,
            "persistence": meta_row["persistence"],
            "comment": meta_row["comment"],
            "partitionKey": meta_row["partition_key"],
        }

        ddl = _build_ddl(schema, table, meta, columns, constraints, foreign_keys, indexes)

        return _ok(
            {
                "table": meta,
                "columns": columns,
                "indexes": indexes,
                "constraints": constraints,
                "foreignKeys": foreign_keys,
                "primaryKey": {"columns": primary_key},
                "ddl": ddl,
            }
        )
    except Exception as exc:
        return _handle(exc)