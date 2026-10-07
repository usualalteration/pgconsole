import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Copy, Database, Eye, Loader2, Table2, WandSparkles } from "lucide-react";
import { toast } from "sonner";

import { copyText, fetchSchemas, fetchTables } from "@/lib/api";
import { quoteIdent, qualifiedName } from "@/lib/sql";
import { formatBytes, formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ActionMenu } from "@/components/workspace/ActionMenu";
import type { SchemaInfo, TableInfo } from "@/lib/types";

interface TableExplorerProps {
  activeTableKey: string | null;
  onOpenTable: (schema: string, table: string) => void;
  onViewData: (schema: string, table: string) => void;
  onOpenInQuery: (schema: string, table: string) => void;
  onGenerateSelect: (schema: string, table: string) => void;
}

interface TableActions {
  onOpenTable: (schema: string, table: string) => void;
  onViewData: (schema: string, table: string) => void;
  onOpenInQuery: (schema: string, table: string) => void;
  onGenerateSelect: (schema: string, table: string) => void;
}

function TableNode({
  table,
  active,
  actions,
}: {
  table: TableInfo;
  active: boolean;
  actions: TableActions;
}) {
  const copyName = async () => {
    if (await copyText(table.name)) toast.success("Table name copied");
  };
  const copyQualified = async () => {
    if (await copyText(`${table.schema}.${table.name}`)) toast.success("Qualified name copied");
  };

  return (
    <div
      className={cn(
        "group/tbl flex cursor-pointer items-center gap-1.5 rounded-md py-1 pl-7 pr-1 text-sm hover:bg-accent/50",
        active && "bg-accent text-accent-foreground",
      )}
      onClick={() => actions.onOpenTable(table.schema, table.name)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          actions.onOpenTable(table.schema, table.name);
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`Open table ${table.schema}.${table.name}`}
    >
      <Table2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate" title={`${table.schema}.${table.name}`}>
        {table.name}
      </span>
      <span className="hidden shrink-0 text-[10px] text-muted-foreground group-hover/tbl:hidden md:inline">
        {formatCount(table.estimatedRows)} · {formatBytes(table.sizeBytes)}
      </span>
      <ActionMenu
        className="opacity-0 group-hover/tbl:opacity-100"
        label={`Actions for table ${table.name}`}
        items={[
          { label: "View Data", icon: <Eye className="h-3.5 w-3.5" />, onSelect: () => actions.onViewData(table.schema, table.name) },
          { label: "Open in Query", icon: <Table2 className="h-3.5 w-3.5" />, onSelect: () => actions.onOpenInQuery(table.schema, table.name) },
          { label: "Generate SELECT", icon: <WandSparkles className="h-3.5 w-3.5" />, onSelect: () => actions.onGenerateSelect(table.schema, table.name) },
          { label: "Copy Table Name", icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => void copyName() },
          { label: "Copy Qualified Name", icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => void copyQualified() },
        ]}
      />
    </div>
  );
}

function SchemaNode({
  schema,
  expanded,
  onToggle,
  filter,
  activeTableKey,
  actions,
}: {
  schema: SchemaInfo;
  expanded: boolean;
  onToggle: () => void;
  filter: string;
  activeTableKey: string | null;
  actions: TableActions;
}) {
  const tablesQuery = useQuery({
    queryKey: ["tables", schema.name],
    queryFn: () => fetchTables(schema.name),
    enabled: expanded,
    staleTime: 30_000,
  });

  const visibleTables = useMemo(() => {
    const all = tablesQuery.data?.tables ?? [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((t) => t.name.toLowerCase().includes(needle));
  }, [tablesQuery.data, filter]);

  return (
    <div>
      <div
        className={cn(
          "flex cursor-pointer select-none items-center gap-1 rounded-md py-1 pl-1 pr-2 text-sm font-medium hover:bg-accent/50",
        )}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        tabIndex={0}
        role="button"
        aria-expanded={expanded}
        aria-label={`Toggle schema ${schema.name}`}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate" title={schema.name}>
          {schema.name}
        </span>
        <Badge variant="muted" className="text-[10px]">
          {schema.tableCount}
        </Badge>
      </div>
      {expanded && (
        <div className="mt-0.5 space-y-0.5">
          {tablesQuery.isLoading && (
            <div className="flex items-center gap-2 py-1 pl-7 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading tables…
            </div>
          )}
          {tablesQuery.isError && (
            <p className="py-1 pl-7 text-xs text-destructive">
              Failed to load tables. {(tablesQuery.error as Error)?.message}
            </p>
          )}
          {!tablesQuery.isLoading && !tablesQuery.isError && visibleTables.length === 0 && (
            <p className="py-1 pl-7 text-xs text-muted-foreground">
              {filter.trim() ? "No matching tables." : "No tables in this schema."}
            </p>
          )}
          {visibleTables.map((table) => (
            <TableNode
              key={table.name}
              table={table}
              active={activeTableKey === `${table.schema}.${table.name}`}
              actions={actions}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function TableExplorer({ activeTableKey, onOpenTable, onViewData, onOpenInQuery, onGenerateSelect }: TableExplorerProps) {
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState("");

  const schemasQuery = useQuery({
    queryKey: ["schemas"],
    queryFn: fetchSchemas,
    staleTime: 60_000,
  });

  const schemas = schemasQuery.data?.schemas ?? [];
  const userSchemas = schemas.filter((s) => !s.internal);
  const needle = filter.trim().toLowerCase();

  const toggleSchema = (name: string) => {
    setExpandedSchemas((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const actions: TableActions = { onOpenTable, onViewData, onOpenInQuery, onGenerateSelect };
  const data = schemasQuery.data;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border p-2">
        <Label htmlFor="explorer-filter" className="sr-only">
          Filter schemas and tables
        </Label>
        <Input
          id="explorer-filter"
          name="explorer-filter"
          type="search"
          placeholder="Filter schemas and tables"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="h-8 text-sm"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {schemasQuery.isLoading && (
          <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading database metadata…
          </div>
        )}
        {schemasQuery.isError && (
          <div className="space-y-2 p-3 text-sm text-destructive">
            <p>Failed to load schemas.</p>
            <p className="break-all font-mono text-xs">{(schemasQuery.error as Error).message}</p>
            <Button size="sm" variant="outline" onClick={() => void schemasQuery.refetch()}>
              Retry
            </Button>
          </div>
        )}
        {schemasQuery.isSuccess && (
          <div className="space-y-0.5">
            {/* Database root */}
            <div className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-semibold">
              <Database className="h-4 w-4 shrink-0 text-primary" />
              <span className="truncate" title={data?.database}>
                {data?.database ?? "Database"}
              </span>
            </div>
            <div className="ml-1 space-y-0.5 border-l border-border pl-1">
              {userSchemas.length === 0 && (
                <p className="py-1 pl-2 text-xs text-muted-foreground">
                  {needle ? "No matching schemas." : "No user schemas are visible."}
                </p>
              )}
              {userSchemas.map((schema) => (
                <SchemaNode
                  key={schema.name}
                  schema={schema}
                  expanded={expandedSchemas.has(schema.name)}
                  onToggle={() => toggleSchema(schema.name)}
                  filter={filter}
                  activeTableKey={activeTableKey}
                  actions={actions}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {data && (
        <div className="border-t border-border px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          <div className="truncate" title={`${data.user}@${data.database}`}>
            {data.user}@{data.database}
          </div>
          <div className="truncate" title={data.serverVersion}>
            PostgreSQL {data.serverVersion.split(" ")[0]}
          </div>
        </div>
      )}
    </div>
  );
}