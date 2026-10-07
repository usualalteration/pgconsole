"""Offline unit checks for the v1/query statement splitter and blocklist.

Run with: python3 tests/query/test_splitter.py
(psycopg is stubbed so the module can be imported without the driver installed.)
"""
import sys
import types
from pathlib import Path

# Stub psycopg modules so query.py can be imported without the driver.
for name in ("psycopg", "psycopg.sql", "psycopg.pq", "psycopg.rows"):
    sys.modules[name] = types.ModuleType(name)
sys.modules["psycopg"].sql = sys.modules["psycopg.sql"]
sys.modules["psycopg"].rows = sys.modules["psycopg.rows"]
sys.modules["psycopg"].pq = sys.modules["psycopg.pq"]
sys.modules["psycopg.pq"].TransactionStatus = type("TransactionStatus", (), {"IDLE": 0})
sys.modules["psycopg.rows"].dict_row = object

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages" / "v1" / "query"))
import query  # noqa: E402

failures = []


def check(name, condition, detail=""):
    if condition:
        print(f"PASS {name}")
    else:
        print(f"FAIL {name} {detail}")
        failures.append(name)


# 1. plain split
stmts = query._split_statements("SELECT 1; SELECT 2")
check("split-basic", len(stmts) == 2, repr(stmts))

# 2. dollar-quoted function body with semicolons stays one statement
sql_fn = "CREATE FUNCTION f() RETURNS int AS $fn$ BEGIN RETURN 1; END $fn$ LANGUAGE plpgsql;"
expected_raw = "CREATE FUNCTION f() RETURNS int AS $fn$ BEGIN RETURN 1; END $fn$ LANGUAGE plpgsql"
stmts = query._split_statements(sql_fn)
check("split-dollar", len(stmts) == 1 and stmts[0][0] == expected_raw, repr(stmts))

# 3. semicolon inside string literal does not split
stmts = query._split_statements("SELECT 'a;b' AS x; SELECT 2")
check("split-string-semicolon", len(stmts) == 2, repr(stmts))

# 4. E'' escaped string with semicolon does not split
stmts = query._split_statements(r"SELECT E'a\';b' AS x; SELECT 2")
check("split-escape-string", len(stmts) == 2, repr(stmts))

# 5. comment-only fragment is skipped
stmts = query._split_statements("-- nothing here\n; SELECT 1")
check("split-comment-only", len(stmts) == 1, repr(stmts))

# 6. block comment is stripped from both policy views (raw keeps it)
raw, no_comments, clean = query._split_statements("/* SET ROLE x */ SELECT 1")[0]
check(
    "blocklist-comment-safe",
    "SET ROLE" in raw and "SET ROLE" not in clean and "SET ROLE" not in no_comments,
    (raw, no_comments, clean),
)

# 7. string literal containing blocked words does not trigger
raw, no_comments, clean = query._split_statements("SELECT 'CREATE USER x'")[0]
try:
    query._check_blocked(clean, no_comments, 0)
    ok = True
except Exception:
    ok = False
check("blocklist-literal-safe", ok)

# 8. set_config('role', ...) is blocked (needs literals view)
raw, no_comments, clean = query._split_statements("SELECT set_config('role', 'postgres', false)")[0]
try:
    query._check_blocked(clean, no_comments, 0)
    ok = False
except query._BlockedStatement:
    ok = True
check("blocklist-set-config-role", ok)

# 9. set_config('statement_timeout', ...) blocked
raw, no_comments, clean = query._split_statements("SELECT set_config('statement_timeout', '0', false)")[0]
try:
    query._check_blocked(clean, no_comments, 0)
    ok = False
except query._BlockedStatement:
    ok = True
check("blocklist-set-config-timeout", ok)

# 10. legitimate set_config is NOT blocked
raw, no_comments, clean = query._split_statements("SELECT set_config('work_mem', '64MB', false)")[0]
try:
    query._check_blocked(clean, no_comments, 0)
    ok = True
except query._BlockedStatement:
    ok = False
check("blocklist-set-config-allowed", ok)

# 11. keyword blocklist
for bad in [
    "SET ROLE postgres",
    "RESET ROLE",
    "CREATE USER u PASSWORD 'x'",
    "ALTER USER u WITH SUPERUSER",
    "DROP ROLE r",
    "SET SESSION AUTHORIZATION 'u'",
    "SET LOCAL statement_timeout = 0",
    "SET SESSION statement_timeout = 0",
    "RESET statement_timeout",
    "ALTER SYSTEM SET statement_timeout = 0",
    "DISCARD ALL",
    "RESET ALL",
]:
    parsed = query._split_statements(bad)
    raw, no_comments, clean = parsed[0]
    try:
        query._check_blocked(clean, no_comments, 0)
        ok = False
    except query._BlockedStatement:
        ok = True
    check(f"blocklist-kw: {bad}", ok)

# 12. allowed statements are not blocked
for good in [
    "SELECT 1",
    "UPDATE t SET a = 1 WHERE id = 2",
    "BEGIN",
    "COMMIT",
    "SET work_mem = '64MB'",
    "SET timezone = 'UTC'",
    "CREATE TABLE t (id int)",
    "GRANT SELECT ON t TO PUBLIC",
    "VACUUM t",
    "CREATE INDEX idx ON t (a)",
]:
    parsed = query._split_statements(good)
    raw, no_comments, clean = parsed[0]
    try:
        query._check_blocked(clean, no_comments, 0)
        ok = True
    except query._BlockedStatement:
        ok = False
    check(f"allowed: {good}", ok)

# 13. command tags
check("command-tag-select", query._first_keyword(query._split_statements("  select 1")[0][2]) == "SELECT")
check("command-tag-update", query._first_keyword(query._split_statements("UPDATE t SET a=1")[0][2]) == "UPDATE")
check(
    "command-tag-parens",
    query._first_keyword(query._split_statements("( SELECT 1 )")[0][2]) == "SELECT",
)

print()
if failures:
    print(f"{len(failures)} FAILURE(S)")
    sys.exit(1)
print("ALL PASS")