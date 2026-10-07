"""v1/query - execute SQL submitted from the console as the single configured PostgreSQL user.

Body: {"sql": "<one or more statements>"}

Safety:
  * statements execute with the permissions of the configured user (autocommit);
  * role/user management, identity switching, session resets and statement
    timeout overrides are rejected before execution (including set_config escapes);
  * a session statement timeout bounds every statement;
  * results are capped (rows and payload size) before serialization.
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
MAX_PAYLOAD_CHARS = 1_500_000
MAX_VALUE_CHARS = 200_000
MAX_SQL_CHARS = 1_000_000
MAX_STATEMENTS = 200
DEFAULT_TIMEOUT_MS = 10_000

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

# Identity/role management and statement-timeout escapes are blocked before execution.
# These patterns are scanned on text without comments and without string literals,
# so literal contents never trigger false positives.
_BLOCKED_RULES = [
    (
        "role and user management",
        re.compile(r"\b(?:CREATE|ALTER|DROP)\s+(?:USER|ROLE)\b", re.I),
    ),
    ("identity switching", re.compile(r"\bSET\s+ROLE\b", re.I)),
    ("identity switching", re.compile(r"\bRESET\s+ROLE\b", re.I)),
    ("identity switching", re.compile(r"\bSET\s+SESSION\s+AUTHORIZATION\b", re.I)),
    (
        "statement timeout override",
        re.compile(r"\b(?:SET|RESET)\s+(?:LOCAL\s+|SESSION\s+)?STATEMENT_TIMEOUT\b", re.I),
    ),
    ("system configuration", re.compile(r"\bALTER\s+SYSTEM\b", re.I)),
    ("session reset", re.compile(r"\bDISCARD\s+ALL\b", re.I)),
    ("session reset", re.compile(r"\bRESET\s+ALL\b", re.I)),
]

# set_config() can bypass SET ROLE / SET SESSION AUTHORIZATION / statement_timeout.
# It is scanned on comment-stripped text that keeps string literals.
_SET_CONFIG_BLOCKED_RE = re.compile(
    r"set_config\s*\(\s*['\"](?:role|session_authorization|statement_timeout)['\"]",
    re.I,
)

_DOLLAR_TAG_RE = re.compile(r"\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$")


class _Failure(Exception):
    def __init__(self, type_name, message, extra=None):
        super().__init__(message)
        self.type_name = type_name
        self.message = message
        self.extra = dict(extra or {})


class _BlockedStatement(_Failure):
    def __init__(self, reason, index):
        super().__init__(
            "PermissionError",
            f"Statement {index + 1} is blocked: {reason} commands are not allowed in this console.",
            {
                "sqlstate": "42501",
                "hint": (
                    "The console always runs as the single configured PostgreSQL user. "
                    "Role management, identity switching, session resets and "
                    "statement-timeout overrides are disabled."
                ),
                "statementIndex": index + 1,
            },
        )


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
    return DEFAULT_TIMEOUT_MS


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


def _is_escape_string(raw_buf):
    """True when a quote directly follows E/e (escape-string constant)."""
    j = len(raw_buf) - 1
    while j >= 0 and raw_buf[j] in " \t\r\n":
        j -= 1
    if j >= 0 and raw_buf[j] in ("E", "e"):
        if j == 0:
            return True
        prev = raw_buf[j - 1]
        return not (prev.isalnum() or prev == "_" or prev == '"')
    return False


def _split_statements(text):
    """Split SQL into statements; returns [(raw, no_comments, clean)].

    raw        keeps strings/comments (executable text);
    no_comments strips comments but keeps literals (set_config() policy scan);
    clean      strips comments and literals (policy checks and command tags).
    Handles line/block comments, '...' / "..." quoting, E'...' escapes and $tag$ dollar quoting.
    """
    statements = []
    raw_buf = []
    nc_buf = []
    clean_buf = []
    state = None
    dollar_tag = ""
    quote_esc = False
    i = 0
    n = len(text)

    def _flush():
        raw = "".join(raw_buf).strip()
        no_comments = "".join(nc_buf).strip()
        clean = "".join(clean_buf).strip()
        raw_buf.clear()
        nc_buf.clear()
        clean_buf.clear()
        if clean:
            statements.append((raw, no_comments, clean))

    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if state == "line":
            raw_buf.append(ch)
            if ch == "\n":
                state = None
            i += 1
            continue
        if state == "block":
            if ch == "*" and nxt == "/":
                raw_buf.append("*/")
                i += 2
                state = None
            else:
                raw_buf.append(ch)
                i += 1
            continue
        if state == "single":
            raw_buf.append(ch)
            nc_buf.append(ch)
            if quote_esc and ch == "\\" and nxt:
                raw_buf.append(nxt)
                nc_buf.append(nxt)
                i += 2
                continue
            if ch == "'":
                if nxt == "'":
                    raw_buf.append("'")
                    nc_buf.append("'")
                    i += 2
                    continue
                state = None
                quote_esc = False
            i += 1
            continue
        if state == "double":
            raw_buf.append(ch)
            nc_buf.append(ch)
            if ch == '"':
                if nxt == '"':
                    raw_buf.append('"')
                    nc_buf.append('"')
                    i += 2
                    continue
                state = None
            i += 1
            continue
        if state == "dollar":
            end = text.find(dollar_tag, i)
            if end == -1:
                raw_buf.append(text[i:])
                nc_buf.append(text[i:])
                i = n
            else:
                stop = end + len(dollar_tag)
                raw_buf.append(text[i:stop])
                nc_buf.append(text[i:stop])
                i = stop
            state = None
            continue

        if ch == "-" and nxt == "-":
            raw_buf.append("--")
            i += 2
            state = "line"
            continue
        if ch == "/" and nxt == "*":
            raw_buf.append("/*")
            i += 2
            state = "block"
            continue
        if ch == "'":
            quote_esc = _is_escape_string(raw_buf)
            raw_buf.append(ch)
            nc_buf.append(ch)
            state = "single"
            i += 1
            continue
        if ch == '"':
            raw_buf.append(ch)
            nc_buf.append(ch)
            state = "double"
            i += 1
            continue
        if ch == "$":
            match = _DOLLAR_TAG_RE.match(text, i)
            if match:
                dollar_tag = match.group(0)
                raw_buf.append(dollar_tag)
                nc_buf.append(dollar_tag)
                state = "dollar"
                i = match.end()
                continue
            raw_buf.append(ch)
            nc_buf.append(ch)
            clean_buf.append(ch)
            i += 1
            continue
        if ch == ";":
            _flush()
            i += 1
            continue
        raw_buf.append(ch)
        nc_buf.append(ch)
        clean_buf.append(ch)
        i += 1

    _flush()
    return statements


def _check_blocked(clean, no_comments, index):
    for reason, pattern in _BLOCKED_RULES:
        if pattern.search(clean):
            raise _BlockedStatement(reason, index)
    if _SET_CONFIG_BLOCKED_RE.search(no_comments):
        raise _BlockedStatement("identity or timeout reconfiguration", index)


def _first_keyword(clean):
    match = re.search(r"[A-Za-z]+", clean)
    return match.group(0).upper() if match else ""


def _collect_rows(conn, cur, command, duration_ms, messages):
    """Fetch and serialize the current result set with row and size caps."""
    fetched = cur.fetchmany(MAX_RESULT_ROWS + 1)
    truncated = len(fetched) > MAX_RESULT_ROWS
    rows = fetched[:MAX_RESULT_ROWS]
    serialized = []
    budget = MAX_PAYLOAD_CHARS
    for row in rows:
        item = {key: _jsonable(value) for key, value in row.items()}
        cost = len(json.dumps(item, default=str))
        if budget - cost < 0:
            truncated = True
            break
        budget -= cost
        serialized.append(item)
    line = f"{command or 'SELECT'} {len(serialized)} row(s)"
    if truncated:
        line += " — result truncated"
    line += f" · {duration_ms} ms"
    messages.append(line)
    return {
        "columns": _describe_columns(conn, cur),
        "rows": serialized,
        "rowCount": len(serialized),
        "truncated": truncated,
    }


def main(args, ctx=None):
    try:
        data = request_data(args)
        sql_text = data.get("sql")
        if not isinstance(sql_text, str) or not sql_text.strip():
            return _fail({"type": "ValidationError", "message": "No SQL statement provided"})
        if len(sql_text) > MAX_SQL_CHARS:
            return _fail({"type": "ValidationError", "message": "SQL text is too large (limit is 1,000,000 characters)"})

        statements = _split_statements(sql_text)
        if not statements:
            return _fail({"type": "ValidationError", "message": "No executable SQL statement found"})
        if len(statements) > MAX_STATEMENTS:
            return _fail({"type": "ValidationError", "message": f"Too many statements in one submission (limit is {MAX_STATEMENTS})"})

        conn = _connect(ctx)
        return _run(conn, statements)
    except Exception as exc:
        return _handle(exc)


def _run(conn, statements):
    notices = []

    def _on_notice(diag):
        try:
            message = getattr(diag, "message_primary", None)
            severity = getattr(diag, "severity", None) or "NOTICE"
            detail = getattr(diag, "message_detail", None)
            line = f"{severity}: {message}" if message else f"{severity}: notice"
            if detail:
                line += f" ({detail})"
            notices.append(_sanitize(line))
        except Exception:
            pass

    conn.add_notice_handler(_on_notice)
    messages = []
    summaries = []
    result = None
    last_rowcount = None
    last_command = ""
    try:
        started = time.monotonic()
        for index, (raw, no_comments, clean) in enumerate(statements):
            _check_blocked(clean, no_comments, index)
            command = _first_keyword(clean)
            with conn.cursor(row_factory=dict_row) as cur:
                t0 = time.monotonic()
                try:
                    cur.execute(raw)
                except psycopg.Error as exc:
                    exc.statement_index = index + 1
                    raise
                duration_ms = int((time.monotonic() - t0) * 1000)
                has_rows = cur.description is not None
                if has_rows:
                    result = _collect_rows(conn, cur, command, duration_ms, messages)
                    last_rowcount = result["rowCount"]
                    summary_rowcount = result["rowCount"]
                else:
                    rowcount = cur.rowcount
                    if rowcount is not None and rowcount >= 0:
                        messages.append(f"{command or 'OK'} {rowcount} · {duration_ms} ms")
                        last_rowcount = rowcount
                        summary_rowcount = rowcount
                    else:
                        messages.append(f"{command or 'OK'} OK · {duration_ms} ms")
                        last_rowcount = None
                        summary_rowcount = 0
                summaries.append(
                    {
                        "index": index,
                        "command": command,
                        "rowCount": summary_rowcount,
                        "durationMs": duration_ms,
                        "hasRows": has_rows,
                    }
                )
            last_command = command
        total_ms = int((time.monotonic() - started) * 1000)
        messages.extend(notices)
        if result is not None:
            payload = {
                "columns": result["columns"],
                "rows": result["rows"],
                "rowCount": result["rowCount"],
                "command": last_command,
                "durationMs": total_ms,
                "messages": messages,
                "statements": summaries,
                "truncated": result["truncated"],
            }
        else:
            payload = {
                "columns": [],
                "rows": [],
                "rowCount": last_rowcount if last_rowcount is not None else 0,
                "command": last_command,
                "durationMs": total_ms,
                "messages": messages,
                "statements": summaries,
                "truncated": False,
            }
        return _ok(payload)
    finally:
        try:
            conn.remove_notice_handler(_on_notice)
        except Exception:
            pass