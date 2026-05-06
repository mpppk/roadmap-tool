import { useCallback, useEffect, useMemo, useState } from "react";
import { CapacityView } from "./CapacityView";
import type { HistoryController, RoadmapSnapshot } from "./history-client";
import { MembersView } from "./MembersView";
import { orpc } from "./orpc-client";

type HistoryEntry = {
  label: string;
  before: RoadmapSnapshot;
  after: RoadmapSnapshot;
};

const HISTORY_LIMIT = 100;

function snapshotsEqual(a: RoadmapSnapshot, b: RoadmapSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isAppUndoSuppressedTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return !!target.closest("input, textarea, [contenteditable='true']");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (
    error !== null &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "undo/redoできませんでした。";
}

export function App() {
  const [path, setPath] = useState(() => window.location.pathname);
  const [undoStack, setUndoStack] = useState<HistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<HistoryEntry[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyWarning, setHistoryWarning] = useState<string | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);

  useEffect(() => {
    const handler = () => setPath(window.location.pathname);
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  const clearHistory = useCallback(() => {
    setUndoStack([]);
    setRedoStack([]);
    setHistoryWarning(null);
  }, []);

  const recordHistoryOperation = useCallback(
    async <T,>(label: string, operation: () => Promise<T>): Promise<T> => {
      setHistoryBusy(true);
      setHistoryWarning(null);
      try {
        const before = await orpc.history.snapshot({});
        let result: T;
        let operationError: unknown;
        try {
          result = await operation();
        } catch (error) {
          operationError = error;
        }

        const after = await orpc.history.snapshot({});
        if (!snapshotsEqual(before, after)) {
          const entry: HistoryEntry = { label, before, after };
          setUndoStack((stack) => [...stack, entry].slice(-HISTORY_LIMIT));
          setRedoStack([]);
        }

        if (operationError) throw operationError;
        return result!;
      } finally {
        setHistoryBusy(false);
      }
    },
    [],
  );

  const undo = useCallback(async () => {
    if (historyBusy || undoStack.length === 0) return;
    const entry = undoStack[undoStack.length - 1];
    if (!entry) return;
    setHistoryBusy(true);
    setHistoryWarning(null);
    try {
      await orpc.history.restore({
        expected: entry.after,
        snapshot: entry.before,
      });
      setUndoStack((stack) => stack.slice(0, -1));
      setRedoStack((stack) => [...stack, entry].slice(-HISTORY_LIMIT));
      setHistoryVersion((version) => version + 1);
    } catch (error) {
      setHistoryWarning(errorMessage(error));
    } finally {
      setHistoryBusy(false);
    }
  }, [historyBusy, undoStack]);

  const redo = useCallback(async () => {
    if (historyBusy || redoStack.length === 0) return;
    const entry = redoStack[redoStack.length - 1];
    if (!entry) return;
    setHistoryBusy(true);
    setHistoryWarning(null);
    try {
      await orpc.history.restore({
        expected: entry.before,
        snapshot: entry.after,
      });
      setRedoStack((stack) => stack.slice(0, -1));
      setUndoStack((stack) => [...stack, entry].slice(-HISTORY_LIMIT));
      setHistoryVersion((version) => version + 1);
    } catch (error) {
      setHistoryWarning(errorMessage(error));
    } finally {
      setHistoryBusy(false);
    }
  }, [historyBusy, redoStack]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      const isUndo = key === "z" && !event.shiftKey;
      const isRedo = (key === "z" && event.shiftKey) || key === "y";
      if (!isUndo && !isRedo) return;
      if (isAppUndoSuppressedTarget(event.target)) return;
      if (
        document.querySelector(".confirm-overlay, .capacity-conflict-popover")
      )
        return;
      event.preventDefault();
      void (isUndo ? undo() : redo());
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo, redo]);

  const controls = useMemo(
    () => (
      <div className="history-controls">
        <button
          type="button"
          className="history-btn"
          onClick={() => void undo()}
          disabled={historyBusy || undoStack.length === 0}
          title={undoStack.at(-1)?.label ?? "Undo"}
        >
          Undo
        </button>
        <button
          type="button"
          className="history-btn"
          onClick={() => void redo()}
          disabled={historyBusy || redoStack.length === 0}
          title={redoStack.at(-1)?.label ?? "Redo"}
        >
          Redo
        </button>
      </div>
    ),
    [historyBusy, undoStack, redoStack, undo, redo],
  );

  const history: HistoryController = useMemo(
    () => ({
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
      busy: historyBusy,
      warning: historyWarning,
      version: historyVersion,
      undo,
      redo,
      clear: clearHistory,
      clearWarning: () => setHistoryWarning(null),
      record: recordHistoryOperation,
      controls,
    }),
    [
      undoStack.length,
      redoStack.length,
      historyBusy,
      historyWarning,
      historyVersion,
      undo,
      redo,
      clearHistory,
      recordHistoryOperation,
      controls,
    ],
  );

  if (path === "/members") return <MembersView history={history} />;
  return <CapacityView history={history} />;
}

export default App;
