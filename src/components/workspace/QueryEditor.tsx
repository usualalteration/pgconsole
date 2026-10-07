import { useEffect, useRef } from "react";
import Editor from "@monaco-editor/react";
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "@/workers/monaco-editor-worker?worker";
import type { editor as MonacoEditorApi } from "monaco-editor";

// Use the locally bundled Monaco (no CDN loading) and provide the editor worker.
(self as unknown as { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};
loader.config({ monaco });

export interface QueryEditorApi {
  focus(): void;
  getSelectionText(): string;
}

interface QueryEditorProps {
  value: string;
  onChange: (value: string) => void;
  /**
   * Called for Ctrl/Cmd+Enter. Receives the selected SQL, or "" when nothing
   * is selected (the caller should then run the whole editor content).
   */
  onRun: (selectionText: string) => void;
  onSelectionChange: (hasSelection: boolean) => void;
  editorApiRef: React.MutableRefObject<QueryEditorApi | null>;
}

export function QueryEditor({ value, onChange, onRun, onSelectionChange, editorApiRef }: QueryEditorProps) {
  const localEditorRef = useRef<MonacoEditorApi.IStandaloneCodeEditor | null>(null);
  const onRunRef = useRef(onRun);
  const onSelectionChangeRef = useRef(onSelectionChange);
  onRunRef.current = onRun;
  onSelectionChangeRef.current = onSelectionChange;

  useEffect(() => {
    return () => {
      editorApiRef.current = null;
    };
  }, [editorApiRef]);

  return (
    <Editor
      language="sql"
      theme="vs"
      value={value}
      onChange={(v) => onChange(v ?? "")}
      loading={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading editor…</div>}
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        lineNumbers: "on",
        automaticLayout: true,
        scrollBeyondLastLine: false,
        renderWhitespace: "selection",
        wordWrap: "off",
        tabSize: 2,
        matchBrackets: "always",
        guides: { bracketPairs: true },
        folding: true,
        stickyScroll: { enabled: false },
        wordBasedSuggestions: "off",
        quickSuggestions: false,
        suggestOnTriggerCharacters: false,
        padding: { top: 8, bottom: 8 },
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      }}
      onMount={(editor) => {
        localEditorRef.current = editor;
        editorApiRef.current = {
          focus: () => editor.focus(),
          getSelectionText: () => {
            const selection = editor.getSelection();
            if (!selection || selection.isEmpty()) return "";
            return editor.getModel()?.getValueInRange(selection) ?? "";
          },
        };

        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
          const selection = editor.getSelection();
          const selectionText =
            selection && !selection.isEmpty()
              ? editor.getModel()?.getValueInRange(selection) ?? ""
              : "";
          onRunRef.current(selectionText);
        });

        editor.onDidChangeCursorSelection(() => {
          const selection = editor.getSelection();
          onSelectionChangeRef.current(!!selection && !selection.isEmpty());
        });
      }}
    />
  );
}