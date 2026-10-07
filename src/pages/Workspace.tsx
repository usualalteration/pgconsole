import { useCallback, useState } from "react";
import { Database, FileCode2, PanelLeft, X } from "lucide-react";

import { buildSelect } from "@/lib/sql";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TableExplorer } from "@/components/workspace/TableExplorer";
import { TableDetails } from "@/components/workspace/TableDetails";
import { QueryWorkspace } from "@/components/workspace/QueryWorkspace";

const INITIAL_SQL = `-- PostgreSQL console: write SQL and press Ctrl/Cmd+Enter to run.
-- Explore tables on the left; "Generate SELECT" places a LIMIT 100 preview query here.
SELECT current_database() AS database, current_user AS connected_as;
`;

type EditorTab = { id: "editor"; kind: "editor" };
type TableTab = { id: string; kind: "table"; schema: string; table: string };
type MainTab = EditorTab | TableTab;

interface InsertRequest {
  text: string;
  nonce: number;
}

const MAX_TABLE_TABS = 8;

const Workspace = () => {
  const [tabs, setTabs] = useState<MainTab[]>([{ id: "editor", kind: "editor" }]);
  const [activeTabId, setActiveTabId] = useState("editor");
  const [sql, setSql] = useState(INITIAL_SQL);
  const [insertRequest, setInsertRequest] = useState<InsertRequest | null>(null);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [initialTabByTable, setInitialTabByTable] = useState<Record<string, "data" | "columns">>({});

  const insertSql = useCallback((text: string) => {
    setInsertRequest((prev) => ({ text, nonce: (prev?.nonce ?? 0) + 1 }));
    setActiveTabId("editor");
  }, []);

  const generateSelect = useCallback(
    (schema: string, table: string) => {
      insertSql(buildSelect(schema, table, 100));
    },
    [insertSql],
  );

  const openTable = useCallback(
    (schema: string, table: string, initialTab: "data" | "columns") => {
      const id = `table:${schema}.${table}`;
      setTabs((prev) => {
        if (prev.some((t) => t.id === id)) return prev;
        const tableTabs = prev.filter((t): t is TableTab => t.kind === "table");
        const base = tableTabs.length >= MAX_TABLE_TABS ? tableTabs.slice(1) : tableTabs;
        return [{ id: "editor", kind: "editor" }, ...base, { id, kind: "table", schema, table }];
      });
      setInitialTabByTable((prev) => ({ ...prev, [id]: initialTab }));
      setActiveTabId(id);
      setExplorerOpen(false);
    },
    [],
  );

  const closeTableTab = useCallback((id: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      return next.length > 0 ? next : [{ id: "editor", kind: "editor" }];
    });
    setActiveTabId((current) => (current === id ? "editor" : current));
  }, []);

  const activeTableTab = tabs.find((t): t is TableTab => t.id === activeTabId && t.kind === "table");

  const explorer = (
    <TableExplorer
      activeTableKey={activeTableTab ? `${activeTableTab.schema}.${activeTableTab.table}` : null}
      onOpenTable={(schema, table) => openTable(schema, table, "columns")}
      onViewData={(schema, table) => openTable(schema, table, "data")}
      onOpenInQuery={generateSelect}
      onGenerateSelect={generateSelect}
    />
  );

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {/* Header */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 lg:hidden"
          aria-label={explorerOpen ? "Close table explorer" : "Open table explorer"}
          aria-expanded={explorerOpen}
          onClick={() => setExplorerOpen((prev) => !prev)}
        >
          <PanelLeft className="h-4 w-4" />
        </Button>
        <Database className="h-5 w-5 text-primary" />
        <h1 className="text-sm font-semibold tracking-tight">PostgreSQL Console</h1>
        <span className="ml-1 hidden text-xs text-muted-foreground md:inline">
          Table Explorer &amp; SQL Query Workspace
        </span>
        <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">
          Runs as the configured database user — role switching is disabled
        </span>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {/* Sidebar (desktop) */}
        <aside className="hidden w-72 shrink-0 border-r border-border lg:block">{explorer}</aside>

        {/* Sidebar drawer (mobile) */}
        {explorerOpen && (
          <div className="absolute inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Table explorer">
            <div className="absolute inset-0 bg-black/30" onClick={() => setExplorerOpen(false)} />
            <div className="absolute inset-y-0 left-0 w-72 border-r border-border bg-background shadow-xl">
              {explorer}
            </div>
          </div>
        )}

        {/* Main area */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Tab strip */}
          <div
            role="tablist"
            aria-label="Workspace views"
            className="flex h-9 shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border bg-muted/40 px-1.5"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTabId === "editor"}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-t-md border-b-2 px-3 text-sm",
                activeTabId === "editor"
                  ? "border-primary bg-background font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setActiveTabId("editor")}
            >
              <FileCode2 className="h-3.5 w-3.5" />
              SQL Editor
            </button>
            {tabs
              .filter((t): t is TableTab => t.kind === "table")
              .map((tab) => (
                <div
                  key={tab.id}
                  className={cn(
                    "group flex max-w-56 shrink-0 items-center gap-1 rounded-t-md border-b-2 px-3 text-sm",
                    activeTabId === tab.id
                      ? "border-primary bg-background font-medium text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTabId === tab.id}
                    className="min-w-0 truncate"
                    title={`${tab.schema}.${tab.table}`}
                    onClick={() => setActiveTabId(tab.id)}
                  >
                    {tab.schema}.{tab.table}
                  </button>
                  <button
                    type="button"
                    aria-label={`Close tab ${tab.schema}.${tab.table}`}
                    className="rounded p-0.5 text-muted-foreground/70 opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                    onClick={() => closeTableTab(tab.id)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
          </div>

          {/* Content */}
          <div className="min-h-0 flex-1 overflow-hidden">
            {activeTabId === "editor" ? (
              <QueryWorkspace sql={sql} setSql={setSql} insertRequest={insertRequest} />
            ) : activeTableTab ? (
              <TableDetails
                key={activeTableTab.id}
                schema={activeTableTab.schema}
                table={activeTableTab.table}
                initialTab={initialTabByTable[activeTableTab.id] === "data" ? "data" : "columns"}
                onOpenInQuery={generateSelect}
                onGenerateSelect={generateSelect}
              />
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
};

export default Workspace;