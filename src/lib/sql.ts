/** SQL helpers: identifier quoting, SELECT generation and formatting. */

import { format } from "sql-formatter";

/** Quote a PostgreSQL identifier the way psycopg sql.Identifier would. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function qualifiedName(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

/** Generate a bounded SELECT for a table, e.g. SELECT * FROM "public"."users" LIMIT 100; */
export function buildSelect(schema: string, table: string, limit = 100): string {
  return `SELECT *\nFROM ${qualifiedName(schema, table)}\nLIMIT ${limit};`;
}

export function formatSql(sqlText: string): string {
  return format(sqlText, {
    language: "postgresql",
    keywordCase: "upper",
    functionCase: "upper",
    expressionWidth: 60,
    logicalOperatorNewline: "before",
  });
}

/** Render a query value as stable text for copy/paste and grid display. */
export function valueToText(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

/** Serialize query rows as TSV (headers first); NULL is written as the literal NULL. */
export function rowsToTsv(columns: { name: string }[], rows: Record<string, unknown>[]): string {
  const header = columns.map((c) => c.name).join("\t");
  const body = rows.map((row) =>
    columns
      .map((c) => {
        const value = row[c.name];
        if (value === null || value === undefined) return "NULL";
        if (typeof value === "object") return JSON.stringify(value);
        return String(value);
      })
      .join("\t"),
  );
  return [header, ...body].join("\n");
}