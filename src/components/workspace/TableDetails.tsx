import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronsLeft,
  ChevronsRight,
  Copy,
  Eye,
  Loader2,
  RefreshCw,
  WandSparkles,
} from "lucide-react";
import { toast } from "sonner";

import { ApiError, copyText, fetchTableData, fetchTableDetails } from "@/lib/api";
import { quoteIdent, rowsToTsv } from "@/lib/sql";
import { formatBytes, formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataGrid } from "@/components/workspace/DataGrid";
import type { QueryValue } from "@/lib/types";

const PAGE_SIZES = [50, 100, 250, 500, 1000];

function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  return (
    <button
      type="button"
      title={`Copy ${label}`}
      aria-label={`Copy ${label}`}
      className={cn(
        "hidden h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground group-hover:flex",
        className,
      )}
      onClick={async () => {
        if (await copyText(text)) toast.success(`${label} copied`);
      }}
    >
      <Copy className="h-3 w-3" />
    </button>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">{message}</div>
  );
}

function DataTableShell({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="h-full overflow-auto">
      <table className="w-full min-w-max text-sm">
        <thead className="sticky top-0 bg-background">
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className="border-b border-border px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

interface DataTabProps {
  schema: string;
  table: string;
  orderedBy: string[];
}

function DataTab({ schema, table, orderedBy }: DataTabProps) {
  const [limit, setLimit] = useState(100);
  const isKeyset = orderedBy.length > 0;
  const [cursorStack, setCursorStack] = useState<(QueryValue[] | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const currentCursor = cursorStack[pageIndex] ?? null;
  const offset = pageIndex * limit;

  const dataQuery = useQuery({
    queryKey: [
      "tableData",
      schema,
      table,
      limit,
      isKeyset ? JSON.stringify(currentCursor) : `offset:${offset}`,
    ],
    queryFn: () => {
      const params: Parameters<typeof fetchTableData>[0] = { schema, table, limit };
      if (isKeyset) {
        if (currentCursor) params.after = currentCursor;
      } else {
        params.offset = offset;
      }
      return fetchTableData(params);
    },
    staleTime: 15_000,
  });

  const data = dataQuery.data;
  const rowCount = data?.rows.length ?? 0;
  const firstRow = offset + (rowCount > 0 ? 1 : 0);
  const lastRow = offset + rowCount;
  const canGoNext = isKeyset ? Boolean(data?.hasMore) : rowCount > 0;

  const goNext = () => {
    if (isKeyset) {
      const nextCursor = data?.nextCursor;
      if (!nextCursor) return;
      setCursorStack((prev) => {
        const next = prev.slice(0, pageIndex + 1);
        next.push(nextCursor);
        return next;
      });
      setPageIndex((p) => p + 1);
    } else {
      setPageIndex((p) => p + 1);
    }
  };

  const copyRows = async () => {
    if (!data || data.rows.length === 0) {
      toast.info("There are no rows to copy.");
      return;
    }
    const ok = await copyText(rowsToTsv(data.columns, data.rows));
    if (ok) toast.success(`Copied ${data.rows.length} row${data.rows.length === 1 ? "" : "s"} as TSV`);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <Label htmlFor={`page-size-${schema}-${table}`} className="whitespace-nowrap text-xs">
            Rows per page
          </Label>
          <select
            id={`page-size-${schema}-${table}`}
            name={`page-size-${schema}-${table}`}
            value={limit}
            onChange={(e) => {
              setLimit(Number(e.target.value));
              setCursorStack([null]);
              setPageIndex(0);
            }}
            className="h-7 rounded-md border border-input bg-background px-1.5 text-xs"
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-0.5">
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            aria-label="First page"
            disabled={pageIndex === 0 || dataQuery.isFetching}
            onClick={() => {
              setCursorStack((prev) => prev.slice(0, 1));
              setPageIndex(0);
            }}
          >
            <ChevronsLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            aria-label="Previous page"
            disabled={pageIndex === 0 || dataQuery.isFetching}
            onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
          >
            <ChevronsLeft className="h-3.5 w-3.5 rotate-180" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            aria-label="Next page"
            disabled={!canGoNext || dataQuery.isFetching}
            onClick={goNext}
          >
            <ChevronsRight className="h-3.5 w-3.5" />
          </Button>
        </div>
        <span className="tabular-nums">
          {dataQuery.isLoading
            ? "Loading…"
            : rowCount === 0
              ? "No rows"
              : `Rows ${firstRow}–${lastRow}`}
        </span>
        {orderedBy.length > 0 && (
          <span className="truncate">
            ordered by <span className="font-mono">{orderedBy.map(quoteIdent).join(", ")}</span>
          </span>
        )}
        {data && (
          <Badge variant="muted" className="text-[10px]">
            {data.mode === "keyset" ? "keyset pagination" : "offset pagination"}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-2 text-xs"
            onClick={() => void copyRows()}
            disabled={!data || data.rows.length === 0}
          >
            <Copy className="h-3 w-3" />
            Copy rows
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-2 text-xs"
            onClick={() => void dataQuery.refetch()}
            disabled={dataQuery.isFetching}
          >
            {dataQuery.isFetching ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Refresh
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {dataQuery.isError ? (
          <EmptyState message={`Failed to load data: ${(dataQuery.error as Error).message}`} />
        ) : dataQuery.isSuccess ? (
          <DataGrid columns={dataQuery.data.columns} rows={dataQuery.data.rows} emptyMessage="No rows in this table." />
        ) : (
          <EmptyState message="Loading rows…" />
        )}
      </div>
    </div>
  );
}

interface TableDetailsProps {
  schema: string;
  table: string;
  initialTab?: "data" | "columns" | "indexes" | "constraints" | "foreign-keys" | "ddl";
  onOpenInQuery: (schema: string, table: string) => void;
  onGenerateSelect: (schema: string, table: string) => void;
}

export function TableDetails({ schema, table, initialTab = "columns", onOpenInQuery, onGenerateSelect }: TableDetailsProps) {
  const [activeTab, setActiveTab] = useState<typeof initialTab>(initialTab);

  const detailsQuery = useQuery({
    queryKey: ["tableDetails", schema, table],
    queryFn: () => fetchTableDetails(schema, table),
  });

  if (detailsQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading table metadata…
      </div>
    );
  }

  if (detailsQuery.isError || !detailsQuery.data) {
    const error =
      detailsQuery.error instanceof ApiError
        ? detailsQuery.error.payload
        : { type: "Error", message: (detailsQuery.error as Error | undefined)?.message ?? "Unknown error" };
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md space-y-3 text-center">
          <p className="text-sm font-medium text-destructive">
            {error.type}: failed to load {schema}.{table}
          </p>
          <p className="break-all font-mono text-xs text-muted-foreground">{error.message}</p>
          <Button size="sm" variant="outline" onClick={() => void detailsQuery.refetch()}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Retry
          </Button>
        </div>
      </div>
    );
  }

  const { table: meta, columns, indexes, constraints, foreignKeys, primaryKey, ddl } = detailsQuery.data;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-3 py-2">
        <h2 className="min-w-0 truncate font-mono text-sm font-semibold" title={`${schema}.${table}`}>
          {quoteIdent(schema)}.{quoteIdent(table)}
        </h2>
        <Badge variant="blue">{meta.kind}</Badge>
        {meta.persistence === "u" && <Badge variant="warning">unlogged</Badge>}
        <span className="text-xs text-muted-foreground">
          Owner <span className="font-medium text-foreground">{meta.owner}</span> · ~
          <span className="font-medium text-foreground" title="Estimated row count (reltuples)">
            {formatCount(meta.estimatedRows)}
          </span>{" "}
          rows · <span className="font-medium text-foreground">{formatBytes(meta.sizeBytes)}</span>
        </span>
        {primaryKey.columns.length > 0 && (
          <span className="hidden text-xs text-muted-foreground lg:inline">
            PK <span className="font-mono">{primaryKey.columns.map(quoteIdent).join(", ")}</span>
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 text-xs"
            onClick={() => setActiveTab("data")}
          >
            <Eye className="h-3.5 w-3.5" />
            View Data
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 text-xs"
            onClick={() => onGenerateSelect(schema, table)}
            title="Place SELECT * FROM ... LIMIT 100 into the SQL editor"
          >
            <WandSparkles className="h-3.5 w-3.5" />
            Generate SELECT
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 text-xs"
            onClick={async () => {
              if (await copyText(`${schema}.${table}`)) toast.success("Qualified name copied");
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            Copy Name
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-6 px-0"
            aria-label="Refresh table metadata"
            onClick={() => void detailsQuery.refetch()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {meta.comment && (
        <p className="border-b border-border bg-muted/40 px-3 py-1 text-xs text-muted-foreground" title={meta.comment}>
          {meta.comment}
        </p>
      )}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)} className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-border px-3 py-1.5">
          <TabsList className="h-8">
            <TabsTrigger value="data" className="px-2.5 py-0.5 text-xs">Data</TabsTrigger>
            <TabsTrigger value="columns" className="px-2.5 py-0.5 text-xs">Columns</TabsTrigger>
            <TabsTrigger value="indexes" className="px-2.5 py-0.5 text-xs">Indexes</TabsTrigger>
            <TabsTrigger value="constraints" className="px-2.5 py-0.5 text-xs">Constraints</TabsTrigger>
            <TabsTrigger value="foreign-keys" className="px-2.5 py-0.5 text-xs">Foreign Keys</TabsTrigger>
            <TabsTrigger value="ddl" className="px-2.5 py-0.5 text-xs">DDL</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="data" className="mt-0 min-h-0 flex-1 overflow-hidden">
          <DataTab schema={schema} table={table} orderedBy={primaryKey.columns} />
        </TabsContent>

        <TabsContent value="columns" className="mt-0 min-h-0 flex-1 overflow-hidden">
          <DataTableShell head={["#", "Name", "Type", "Nullable", "Default", "Identity", "Generated", "Collation", "Comment"]}>
            {columns.map((col) => (
              <tr key={col.name} className="group border-b border-border/60 hover:bg-muted/30">
                <td className="px-3 py-1 text-xs tabular-nums text-muted-foreground">{col.position}</td>
                <td className="group flex items-center gap-1 px-3 py-1">
                  <span className="font-mono">{col.name}</span>
                  <CopyButton text={quoteIdent(col.name)} label={`quoted identifier ${quoteIdent(col.name)}`} />
                </td>
                <td className="px-3 py-1 font-mono text-xs text-muted-foreground">{col.type}</td>
                <td className="px-3 py-1">
                  {col.nullable ? (
                    <Badge variant="muted">NULL</Badge>
                  ) : (
                    <Badge variant="secondary">NOT NULL</Badge>
                  )}
                </td>
                <td className="max-w-56 truncate px-3 py-1 font-mono text-xs" title={col.default ?? ""}>
                  {col.default ?? <span className="italic text-muted-foreground/70">NULL</span>}
                </td>
                <td className="px-3 py-1 text-xs">{col.identity ? `IDENTITY ${col.identity}` : "—"}</td>
                <td className="px-3 py-1 text-xs">{col.generated ? `GENERATED ${col.generated}` : "—"}</td>
                <td className="px-3 py-1 font-mono text-xs text-muted-foreground">{col.collation ?? "—"}</td>
                <td className="max-w-56 truncate px-3 py-1 text-xs text-muted-foreground" title={col.comment ?? ""}>
                  {col.comment ?? "—"}
                </td>
              </tr>
            ))}
          </DataTableShell>
        </TabsContent>

        <TabsContent value="indexes" className="mt-0 min-h-0 flex-1 overflow-hidden">
          {indexes.length === 0 ? (
            <EmptyState message="This table has no indexes." />
          ) : (
            <DataTableShell head={["Name", "Method", "Unique", "Primary", "Columns", "Definition"]}>
              {indexes.map((idx) => (
                <tr key={idx.name} className="border-b border-border/60 align-top hover:bg-muted/30">
                  <td className="px-3 py-1 font-mono text-xs">
                    {idx.name}
                    {idx.constraintName && <Badge variant="muted" className="ml-1.5 text-[10px]">{idx.constraintName}</Badge>}
                  </td>
                  <td className="px-3 py-1 text-xs">{idx.method}</td>
                  <td className="px-3 py-1 text-xs">{idx.unique ? "yes" : "no"}</td>
                  <td className="px-3 py-1 text-xs">{idx.primary ? "yes" : "no"}</td>
                  <td className="max-w-64 truncate px-3 py-1 font-mono text-xs text-muted-foreground" title={idx.columns.join(", ")}>
                    {idx.columns.join(", ") || "—"}
                  </td>
                  <td className="max-w-md px-3 py-1">
                    <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">
                      {idx.definition}
                    </pre>
                  </td>
                </tr>
              ))}
            </DataTableShell>
          )}
        </TabsContent>

        <TabsContent value="constraints" className="mt-0 min-h-0 flex-1 overflow-hidden">
          {constraints.length === 0 ? (
            <EmptyState message="This table has no constraints." />
          ) : (
            <DataTableShell head={["Kind", "Name", "Columns", "Definition", "Validated"]}>
              {constraints.map((cst) => (
                <tr key={cst.name} className="border-b border-border/60 align-top hover:bg-muted/30">
                  <td className="px-3 py-1">
                    <Badge variant={cst.kind === "p" ? "success" : cst.kind === "u" ? "blue" : "muted"}>
                      {cst.kindLabel}
                    </Badge>
                  </td>
                  <td className="px-3 py-1 font-mono text-xs">{cst.name}</td>
                  <td className="px-3 py-1 font-mono text-xs text-muted-foreground">{cst.columns.join(", ") || "—"}</td>
                  <td className="max-w-md px-3 py-1">
                    <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">
                      {cst.definition}
                    </pre>
                  </td>
                  <td className="px-3 py-1 text-xs">{cst.validated ? "yes" : "NO"}</td>
                </tr>
              ))}
            </DataTableShell>
          )}
        </TabsContent>

        <TabsContent value="foreign-keys" className="mt-0 min-h-0 flex-1 overflow-hidden">
          {foreignKeys.length === 0 ? (
            <EmptyState message="This table has no foreign keys." />
          ) : (
            <DataTableShell head={["Name", "Columns", "References", "On Update", "On Delete"]}>
              {foreignKeys.map((fk) => (
                <tr key={fk.name} className="border-b border-border/60 align-top hover:bg-muted/30">
                  <td className="px-3 py-1 font-mono text-xs">{fk.name}</td>
                  <td className="px-3 py-1 font-mono text-xs text-muted-foreground">{fk.columns.join(", ")}</td>
                  <td className="px-3 py-1 font-mono text-xs">
                    {fk.refSchema}.{fk.refTable} <span className="text-muted-foreground">({fk.refColumns.join(", ")})</span>
                  </td>
                  <td className="px-3 py-1 text-xs">{fk.onUpdate}</td>
                  <td className="px-3 py-1 text-xs">{fk.onDelete}</td>
                </tr>
              ))}
            </DataTableShell>
          )}
        </TabsContent>

        <TabsContent value="ddl" className="mt-0 min-h-0 flex-1 overflow-hidden">
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-end border-b border-border px-3 py-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-6 gap-1 px-2 text-xs"
                onClick={async () => {
                  if (await copyText(ddl)) toast.success("DDL copied");
                }}
              >
                <Copy className="h-3 w-3" />
                Copy DDL
              </Button>
            </div>
            <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed text-muted-foreground">
              {ddl}
            </pre>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}