import { AlertTriangle, Info } from "lucide-react";

import { formatDuration } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataGrid } from "@/components/workspace/DataGrid";
import type { ApiErrorPayload, QueryResult } from "@/lib/types";

export interface RunState {
  status: "idle" | "running" | "success" | "error";
  result?: QueryResult;
  error?: ApiErrorPayload;
}

interface ResultsPanelProps {
  runState: RunState;
  activeTab: "results" | "messages" | "error";
  onTabChange: (tab: "results" | "messages" | "error") => void;
}

function ErrorDetails({ error }: { error: ApiErrorPayload }) {
  const rows: { label: string; value: string }[] = [
    { label: "Type", value: error.type },
    ...(error.sqlstate ? [{ label: "SQLSTATE", value: error.sqlstate }] : []),
    ...(error.position ? [{ label: "Position", value: error.position }] : []),
    ...(error.constraint ? [{ label: "Constraint", value: error.constraint }] : []),
    ...(error.table ? [{ label: "Table", value: `${error.schema ?? ""}${error.schema ? "." : ""}${error.table}`.replace(/^\./, "") }] : []),
    ...(error.column ? [{ label: "Column", value: error.column }] : []),
    ...(error.statementIndex != null ? [{ label: "Statement", value: `#${error.statementIndex}` }] : []),
  ];
  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-destructive">{error.type}</span>
              {error.sqlstate && <Badge variant="destructive">SQLSTATE {error.sqlstate}</Badge>}
              {error.statementIndex != null && <Badge variant="outline">Statement #{error.statementIndex}</Badge>}
            </div>
            <p className="whitespace-pre-wrap break-words font-mono text-sm">{error.message}</p>
            {error.detail && (
              <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">Detail: {error.detail}</p>
            )}
            {error.hint && (
              <p className="whitespace-pre-wrap break-words text-sm text-amber-700">Hint: {error.hint}</p>
            )}
          </div>
        </div>
        {rows.length > 1 && (
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-sm">
              <tbody>
                {rows.slice(1).map((row) => (
                  <tr key={row.label} className="border-b border-border/60 last:border-b-0">
                    <td className="w-36 bg-muted/50 px-3 py-1.5 font-medium text-muted-foreground">{row.label}</td>
                    <td className="px-3 py-1.5 font-mono">{row.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function MessagesList({ messages }: { messages: string[] }) {
  if (messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        No messages.
      </div>
    );
  }
  return (
    <div className="h-full overflow-auto p-4">
      <ul className="mx-auto max-w-3xl space-y-1.5">
        {messages.map((message, index) => (
          <li
            key={index}
            className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-1.5 font-mono text-xs"
          >
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="break-all">{message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ResultsPanel({ runState, activeTab, onTabChange }: ResultsPanelProps) {
  const { status, result, error } = runState;

  if (status === "idle") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm font-medium text-muted-foreground">No query executed yet</p>
        <p className="max-w-md text-xs text-muted-foreground/80">
          Write SQL above and press <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono">Ctrl</kbd>
          {" / "}
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono">Cmd</kbd>
          {" + "}
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono">Enter</kbd> to run it. Explore a
          table on the left to inspect its data, columns, indexes, constraints and DDL.
        </p>
      </div>
    );
  }

  if (status === "running") {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Executing query…
      </div>
    );
  }

  const statementCount = result?.statements.length ?? 0;

  return (
    <Tabs value={activeTab} onValueChange={(v) => onTabChange(v as typeof activeTab)} className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-1.5">
        <TabsList className="h-7">
          <TabsTrigger value="results" className="px-2.5 py-0.5 text-xs">Results</TabsTrigger>
          <TabsTrigger value="messages" className="px-2.5 py-0.5 text-xs">
            Messages{result?.messages.length ? ` (${result.messages.length})` : ""}
          </TabsTrigger>
          {status === "error" && (
            <TabsTrigger value="error" className="px-2.5 py-0.5 text-xs text-destructive data-[state=active]:text-destructive">
              Error
            </TabsTrigger>
          )}
        </TabsList>
        {status === "success" && result && (
          <div className="flex items-center gap-2 overflow-hidden text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{result.command || "OK"}</span>
            <span>·</span>
            <span>{result.rowCount} row{result.rowCount === 1 ? "" : "s"}</span>
            <span>·</span>
            <span>{formatDuration(result.durationMs)}</span>
            {result.truncated && <Badge variant="warning">truncated</Badge>}
            {statementCount > 1 && <Badge variant="muted">{statementCount} statements</Badge>}
          </div>
        )}
      </div>
      <TabsContent value="results" className="mt-0 min-h-0 flex-1 overflow-hidden">
        {status === "success" && result ? (
          <DataGrid
            columns={result.columns}
            rows={result.rows}
            emptyMessage={result.columns.length === 0 ? "Command completed — no result set." : "No rows returned."}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
            The query failed — see the Error tab.
          </div>
        )}
      </TabsContent>
      <TabsContent value="messages" className="mt-0 min-h-0 flex-1 overflow-hidden">
        <MessagesList messages={result?.messages ?? []} />
      </TabsContent>
      {status === "error" && (
        <TabsContent value="error" className="mt-0 min-h-0 flex-1 overflow-hidden">
          <ErrorDetails error={error ?? { type: "Error", message: "Unknown error" }} />
        </TabsContent>
      )}
    </Tabs>
  );
}