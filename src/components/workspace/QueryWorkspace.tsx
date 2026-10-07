import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Eraser, History, Loader2, Play, WandSparkles } from "lucide-react";
import { toast } from "sonner";

import { ApiError, copyText, runSql } from "@/lib/api";
import { formatSql, rowsToTsv } from "@/lib/sql";
import { formatTimeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { QueryEditor, type QueryEditorApi } from "@/components/workspace/QueryEditor";
import { ResultsPanel, type RunState } from "@/components/workspace/ResultsPanel";
import { ActionMenu } from "@/components/workspace/ActionMenu";

const HISTORY_KEY = "pgconsole:history";
const HISTORY_MAX = 20;

interface HistoryEntry {
  sql: string;
  at: number;
}

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

interface QueryWorkspaceProps {
  sql: string;
  setSql: (sql: string) => void;
  /** When set, the editor content is replaced with this SQL and the editor gains focus. */
  insertRequest: { text: string; nonce: number } | null;
}

export function QueryWorkspace({ sql, setSql, insertRequest }: QueryWorkspaceProps) {
  const [runState, setRunState] = useState<RunState>({ status: "idle" });
  const [resultTab, setResultTab] = useState<"results" | "messages" | "error">("results");
  const [hasSelection, setHasSelection] = useState(false);
  const [editorPct, setEditorPct] = useState(40);
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  const [historyOpen, setHistoryOpen] = useState(false);

  const editorApiRef = useRef<QueryEditorApi | null>(null);
  const sqlRef = useRef(sql);
  sqlRef.current = sql;
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const pushHistory = useCallback((sqlText: string) => {
    setHistory((prev) => {
      const next = [{ sql: sqlText, at: Date.now() }, ...prev.filter((h) => h.sql !== sqlText)].slice(0, HISTORY_MAX);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      } catch {
        // Local history persistence is best-effort only.
      }
      return next;
    });
  }, []);

  const executeSql = useCallback(
    async (sqlText: string) => {
      if (!sqlText.trim()) {
        toast.error("Nothing to run — the editor is empty.");
        return;
      }
      setRunState({ status: "running" });
      try {
        const result = await runSql(sqlText);
        setRunState({ status: "success", result });
        pushHistory(sqlText);
        if (result.rows.length > 0 || result.columns.length > 0) {
          setResultTab("results");
        } else {
          setResultTab("messages");
        }
      } catch (err) {
        const payload =
          err instanceof ApiError
            ? err.payload
            : { type: "Error", message: err instanceof Error ? err.message : String(err) };
        setRunState({ status: "error", error: payload });
        setResultTab("error");
      }
    },
    [pushHistory],
  );

  // Handle "insert into editor" requests coming from the Table Explorer / details views.
  const lastNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!insertRequest || lastNonceRef.current === insertRequest.nonce) return;
    lastNonceRef.current = insertRequest.nonce;
    setSql(insertRequest.text);
    requestAnimationFrame(() => editorApiRef.current?.focus());
  }, [insertRequest, setSql]);

  const runAll = useCallback(() => void executeSql(sqlRef.current), [executeSql]);
  const runSelection = useCallback(() => {
    const selection = editorApiRef.current?.getSelectionText() ?? "";
    if (selection.trim()) {
      void executeSql(selection);
    } else {
      toast.info("Select some SQL first to run only the selection.");
    }
  }, [executeSql]);

  const handleHotkeyRun = useCallback(
    (selectionText: string) => {
      void executeSql(selectionText.trim() ? selectionText : sqlRef.current);
    },
    [executeSql],
  );

  const onFormat = useCallback(() => {
    try {
      setSql(formatSql(sqlRef.current));
    } catch (err) {
      toast.error(`Could not format SQL: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [setSql]);

  const onClear = useCallback(() => setSql(""), [setSql]);

  const onCopySql = useCallback(async () => {
    const ok = await copyText(sqlRef.current);
    if (ok) toast.success("SQL copied");
    else toast.error("Copy failed");
  }, []);

  const onCopyResults = useCallback(async () => {
    const result = runState.result;
    if (!result || result.rows.length === 0) {
      toast.info("There are no result rows to copy.");
      return;
    }
    const ok = await copyText(rowsToTsv(result.columns, result.rows));
    if (ok) toast.success(`Copied ${result.rows.length} row${result.rows.length === 1 ? "" : "s"} as TSV`);
    else toast.error("Copy failed");
  }, [runState]);

  const onDragStart = (event: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onDragMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pct = ((event.clientY - rect.top) / rect.height) * 100;
    setEditorPct(Math.min(75, Math.max(15, pct)));
  };
  const onDragEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // pointer capture may already be released
    }
  };

  const historyItems = useMemo(
    () =>
      history.map((entry, i) => ({
        label: `${formatTimeAgo(entry.at)} — ${entry.sql.replace(/\s+/g, " ").slice(0, 60)}${entry.sql.length > 60 ? "…" : ""}`,
        onSelect: () => {
          setSql(entry.sql);
          requestAnimationFrame(() => editorApiRef.current?.focus());
        },
      })),
    [history, setSql],
  );

  const running = runState.status === "running";

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5">
        <Button size="sm" onClick={runAll} disabled={running} className="h-7 gap-1.5">
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          Run
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={runSelection}
          disabled={running || !hasSelection}
          className="h-7 gap-1.5"
          title="Run only the selected SQL"
        >
          <Play className="h-3.5 w-3.5" />
          Run Selection
        </Button>
        <span className="ml-1 hidden text-[10px] text-muted-foreground sm:inline">
          <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono">Ctrl/Cmd+Enter</kbd> runs
          selection or all
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={onFormat} disabled={running} className="h-7 gap-1.5">
            <WandSparkles className="h-3.5 w-3.5" />
            Format
          </Button>
          <Button size="sm" variant="ghost" onClick={onClear} disabled={running} className="h-7 gap-1.5">
            <Eraser className="h-3.5 w-3.5" />
            Clear
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void onCopySql()} className="h-7 gap-1.5">
            <Copy className="h-3.5 w-3.5" />
            Copy SQL
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void onCopyResults()}
            disabled={!runState.result || runState.result.rows.length === 0}
            className="h-7 gap-1.5"
          >
            <Copy className="h-3.5 w-3.5" />
            Copy Results
          </Button>
          <div className="relative">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5"
              aria-haspopup="menu"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen((prev) => !prev)}
            >
              <History className="h-3.5 w-3.5" />
              History
            </Button>
            {historyOpen && (
              <div
                className="absolute right-0 z-50 mt-1 max-h-80 w-96 overflow-auto rounded-md border border-border bg-popover p-1 shadow-md"
                onMouseLeave={() => setHistoryOpen(false)}
              >
                {historyItems.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-muted-foreground">No history yet.</p>
                ) : (
                  historyItems.map((item, i) => (
                    <button
                      key={`${i}-${history[i].at}`}
                      type="button"
                      className="block w-full truncate rounded-sm px-2 py-1.5 text-left font-mono text-xs hover:bg-accent hover:text-accent-foreground"
                      title={history[i].sql}
                      onClick={() => {
                        item.onSelect();
                        setHistoryOpen(false);
                      }}
                    >
                      <span className="mr-2 text-muted-foreground">{formatTimeAgo(history[i].at)}</span>
                      {history[i].sql.replace(/\s+/g, " ").slice(0, 70)}
                    </button>
                  ))
                )}
                {historyItems.length > 0 && (
                  <button
                    type="button"
                    className="mt-1 w-full rounded-sm border-t border-border px-2 py-1.5 text-left text-xs text-destructive hover:bg-accent"
                    onClick={() => {
                      setHistory([]);
                      try {
                        localStorage.removeItem(HISTORY_KEY);
                      } catch {
                        // best-effort
                      }
                      setHistoryOpen(false);
                    }}
                  >
                    Clear history
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Editor + resizable results */}
      <div
        className="min-h-[180px] border-b border-border"
        style={{ height: `${editorPct}%`, flex: "0 0 auto" }}
      >
        <QueryEditor
          value={sql}
          onChange={setSql}
          onRun={handleHotkeyRun}
          onSelectionChange={setHasSelection}
          editorApiRef={editorApiRef}
        />
      </div>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize editor and results"
        tabIndex={0}
        className={cn(
          "h-1.5 shrink-0 cursor-row-resize bg-border/60 transition-colors hover:bg-primary/40",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp") setEditorPct((p) => Math.min(75, p + 4));
          if (event.key === "ArrowDown") setEditorPct((p) => Math.max(15, p - 4));
        }}
      />
      <div className="min-h-[140px] flex-1 overflow-hidden">
        <ResultsPanel runState={runState} activeTab={resultTab} onTabChange={setResultTab} />
      </div>
    </div>
  );
}