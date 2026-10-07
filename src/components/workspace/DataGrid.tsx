import { Copy } from "lucide-react";
import { toast } from "sonner";

import { copyText } from "@/lib/api";
import { valueToText } from "@/lib/sql";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import type { QueryColumn, QueryRow, QueryValue } from "@/lib/types";

const NUMERIC_TYPES = new Set([
  "smallint",
  "integer",
  "bigint",
  "real",
  "double precision",
  "numeric",
  "money",
]);
const TEMPORAL_TYPES = new Set([
  "date",
  "time",
  "time with time zone",
  "timestamp",
  "timestamp with time zone",
  "interval",
]);

function isNumericType(type: string): boolean {
  return NUMERIC_TYPES.has(type) || type.startsWith("numeric");
}

function JsonValue({ value }: { value: QueryValue }) {
  return (
    <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/60 px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function renderValue(value: QueryValue, type: string): React.ReactNode {
  if (value === null || value === undefined) {
    return <span className="italic text-muted-foreground/70">NULL</span>;
  }
  if (typeof value === "boolean") {
    return (
      <Badge variant={value ? "success" : "destructive"} className="font-mono">
        {String(value)}
      </Badge>
    );
  }
  if (type === "json" || type === "jsonb" || typeof value === "object") {
    return <JsonValue value={value} />;
  }
  if (type === "bytea") {
    return (
      <span className="flex items-center gap-1.5 font-mono text-xs">
        <Badge variant="muted">bytea</Badge>
        <span className="truncate">{String(value)}</span>
      </span>
    );
  }
  const className = cn(
    (isNumericType(type) || type === "uuid" || TEMPORAL_TYPES.has(type)) && "font-mono text-[13px]",
    isNumericType(type) && "tabular-nums",
  );
  return <span className={className}>{String(value)}</span>;
}

interface DataGridProps {
  columns: QueryColumn[];
  rows: QueryRow[];
  /** Column names to hide (e.g. primary key columns used as cursors). Unused by default. */
  emptyMessage?: string;
}

/**
 * Read-only results grid: sticky headers, horizontal/vertical scrolling,
 * explicit NULL display, per-cell and per-row copy.
 */
export function DataGrid({ columns, rows, emptyMessage }: DataGridProps) {
  if (rows.length === 0 || columns.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        {emptyMessage ?? "No rows returned."}
      </div>
    );
  }

  const copyValue = async (value: QueryValue) => {
    const ok = await copyText(valueToText(value));
    if (ok) toast.success("Copied cell value");
    else toast.error("Copy failed");
  };

  const copyRow = async (row: QueryRow) => {
    const text = columns
      .map((c) => (row[c.name] === null || row[c.name] === undefined ? "NULL" : valueToText(row[c.name]).replace(/\t|\n/g, " ")))
      .join("\t");
    const ok = await copyText(text);
    if (ok) toast.success("Copied row");
    else toast.error("Copy failed");
  };

  return (
    <div className="h-full w-full overflow-auto">
      <table className="w-max min-w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10">
          <tr className="bg-background">
            <th className="w-10 border-b border-border px-2 py-1.5 text-left text-xs font-medium text-muted-foreground">
              <span className="sr-only">Row actions</span>
            </th>
            {columns.map((column) => (
              <th
                key={column.name}
                scope="col"
                className="whitespace-nowrap border-b border-border px-2 py-1.5 text-left"
              >
                <span className="text-xs font-semibold text-foreground">{column.name}</span>
                <span className="ml-1.5 text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
                  {column.type}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="group/row odd:bg-muted/30 hover:bg-accent/40">
              <td className="border-b border-border/60 px-1 py-1 text-center align-middle">
                <span className="block text-[10px] tabular-nums text-muted-foreground/80 group-hover/row:hidden">
                  {rowIndex + 1}
                </span>
                <button
                  type="button"
                  title="Copy row as TSV"
                  aria-label={`Copy row ${rowIndex + 1}`}
                  className="hidden h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground group-hover/row:flex"
                  onClick={() => void copyRow(row)}
                >
                  <Copy className="h-3 w-3" />
                </button>
              </td>
              {columns.map((column) => {
                const value = row[column.name] ?? null;
                const text = valueToText(value);
                return (
                  <td key={column.name} className="max-w-[28rem] border-b border-border/60 px-2 py-1 align-top">
                    <div className="group/cell relative">
                      <div className="truncate" title={text.length > 256 ? `${text.slice(0, 256)}…` : text}>
                        {renderValue(value, column.type)}
                      </div>
                      <button
                        type="button"
                        title="Copy cell"
                        aria-label={`Copy ${column.name} in row ${rowIndex + 1}`}
                        className="absolute right-0 top-0 hidden h-4 w-4 items-center justify-center rounded bg-background/90 text-muted-foreground shadow-sm hover:text-foreground group-hover/cell:flex"
                        onClick={() => void copyValue(value)}
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}