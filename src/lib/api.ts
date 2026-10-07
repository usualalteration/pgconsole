/** API client for the OpenServerless PostgreSQL actions (relative /api/my URLs). */

import type {
  ApiErrorPayload,
  Envelope,
  QueryResult,
  QueryValue,
  SchemasData,
  TableDataData,
  TableDetailsData,
  TablesData,
} from "./types";

const BASE = "/api/my/v1";

export class ApiError extends Error {
  payload: ApiErrorPayload;

  constructor(payload: ApiErrorPayload) {
    super(payload.message);
    this.name = "ApiError";
    this.payload = payload;
  }
}

/** Redact connection strings or passwords if they ever appear in a backend message. */
function sanitizeBackendText(text: string): string {
  return text
    .replace(/(postgres(?:ql)?(?:\+[^:\s/]*)?:\/\/)[^\s'"]*/gi, "$1[redacted]")
    .replace(/(password\s*[=:]\s*)\S+/gi, "$1[redacted]");
}

function unwrapEnvelope(raw: unknown): Envelope<unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;
  if ("ok" in candidate && typeof candidate.ok === "boolean") {
    return candidate as unknown as Envelope<unknown>;
  }
  // Generated wrappers may nest the module return value under "body".
  const body = candidate.body;
  if (body && typeof body === "object" && "ok" in (body as Record<string, unknown>)) {
    return body as unknown as Envelope<unknown>;
  }
  return null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, init);
  } catch {
    throw new ApiError({
      type: "NetworkError",
      message: "Could not reach the backend. Check your connection and try again.",
    });
  }

  let raw: unknown = null;
  try {
    raw = await response.json();
  } catch {
    raw = null;
  }

  const envelope = unwrapEnvelope(raw);
  if (envelope) {
    if (envelope.ok) {
      return (envelope.data ?? null) as T;
    }
    throw new ApiError(
      envelope.error ?? { type: "Error", message: "The request failed without an error message." },
    );
  }

  // Non-envelope responses come from wrapper/platform failures (e.g. database unreachable).
  const rawObj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const rawMessage =
    rawObj && typeof rawObj.error === "string"
      ? sanitizeBackendText(rawObj.error)
      : null;
  throw new ApiError({
    type: "HttpError",
    message:
      rawMessage ??
      (response.ok
        ? "Unexpected response format from the backend."
        : `Request failed with status ${response.status}.`),
    detail: response.ok ? undefined : `HTTP ${response.status}`,
  });
}

export async function fetchSchemas(): Promise<SchemasData> {
  return request<SchemasData>("/schemas");
}

export async function fetchTables(schema: string): Promise<TablesData> {
  return request<TablesData>(`/tables?schema=${encodeURIComponent(schema)}`);
}

export async function fetchTableDetails(schema: string, table: string): Promise<TableDetailsData> {
  const qs = new URLSearchParams({ schema, table });
  return request<TableDetailsData>(`/table-details?${qs.toString()}`);
}

export interface TableDataParams {
  schema: string;
  table: string;
  limit: number;
  offset?: number;
  after?: QueryValue[] | null;
}

export async function fetchTableData(params: TableDataParams): Promise<TableDataData> {
  const qs = new URLSearchParams({
    schema: params.schema,
    table: params.table,
    limit: String(params.limit),
  });
  if (params.offset != null) qs.set("offset", String(params.offset));
  if (params.after) qs.set("after", JSON.stringify(params.after));
  return request<TableDataData>(`/table-data?${qs.toString()}`);
}

export async function runSql(sql: string): Promise<QueryResult> {
  return request<QueryResult>("/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql }),
  });
}

/** Copy text to the clipboard with a legacy fallback. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}