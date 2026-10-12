#--kind python:default
#--web true
# Note: this timeout is 5 minutes - 10 minutes is max allowed
#--timeout 300000
import types, os, table_data

builder = []
## build-context ##
#--param APPSUITE2__POSTGRES_URL "$APPSUITE2__POSTGRES_URL"
def init_appsuite2__postgres_url(args, ctx):
  value = args.get("APPSUITE2__POSTGRES_URL") or os.getenv("APPSUITE2__POSTGRES_URL")
  if not value:
    raise RuntimeError("Required secret APPSUITE2__POSTGRES_URL is not configured")
  setattr(ctx, "APPSUITE2__POSTGRES_URL", value)
builder.append(init_appsuite2__postgres_url)
#--param POSTGRES_URL "$POSTGRES_URL"
import psycopg
def init_postgresql(args, ctx):
  dburl = args.get("POSTGRES_URL", os.getenv("POSTGRES_URL"))
  ctx.POSTGRESQL = psycopg.connect(dburl)
builder.append(init_postgresql)

def main(args):
  try:
    ctx = types.SimpleNamespace()
    for fn in builder: fn(args, ctx)
    return { "body": table_data.main(args, ctx=ctx) }
  except Exception as e:
    import traceback
    traceback.print_exc()
    return {
      "body": {"error": str(e) },
      "statusCode": 500
    }
