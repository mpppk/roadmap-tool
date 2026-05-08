import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CapacityView } from "./CapacityView";
import type { HistoryController, RoadmapSnapshot } from "./history-client";
import { MembersView } from "./MembersView";
import { orpc, roadmapClientId } from "./orpc-client";

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
  const [externalDataVersion, setExternalDataVersion] = useState(0);
  const historyQueueRef = useRef<Promise<void>>(Promise.resolve());
  const historyPendingRef = useRef(0);

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

  useEffect(() => {
    const url = new URL("/events/data-changes", window.location.origin);
    url.searchParams.set("clientId", roadmapClientId);
    const events = new EventSource(url);

    const onDataChanged = (event: MessageEvent<string>) => {
      const payload = JSON.parse(event.data) as {
        version: number;
        sourceClientId?: string;
      };
      if (payload.sourceClientId === roadmapClientId) return;
      clearHistory();
      setExternalDataVersion((version) => version + 1);
    };

    events.addEventListener("roadmap-data-changed", onDataChanged);
    return () => {
      events.removeEventListener("roadmap-data-changed", onDataChanged);
      events.close();
    };
  }, [clearHistory]);

  const recordHistoryOperation = useCallback(
    <T,>(label: string, operation: () => Promise<T>): Promise<T> => {
      // Mark busy immediately so buttons disable before the task actually starts.
      historyPendingRef.current++;
      setHistoryBusy(true);
      setHistoryWarning(null);

      // Chain onto the existing queue so concurrent calls are serialised.
      const task = historyQueueRef.current.then(async (): Promise<T> => {
        const before = await orpc.history.snapshot({});
        let result: T;
        let operationError: unknown;
        try {
          result = await operation();
        } catch (error) {
          operationError = error;
        }

        // P2: if the post-op snapshot fails, the mutation already succeeded on
        // the server — return the result without recording a history entry
        // rather than surfacing a spurious error to the caller.
        let after: RoadmapSnapshot;
        try {
          after = await orpc.history.snapshot({});
        } catch {
          if (operationError) throw operationError;
          return result!;
        }

        if (!snapshotsEqual(before, after)) {
          const entry: HistoryEntry = { label, before, after };
          setUndoStack((stack) => [...stack, entry].slice(-HISTORY_LIMIT));
          setRedoStack([]);
        }

        if (operationError) throw operationError;
        return result!;
      });

      // Update the queue tail; clear busy only when *all* enqueued tasks finish.
      const cleanup = task.then(
        () => {
          historyPendingRef.current--;
          if (historyPendingRef.current === 0) setHistoryBusy(false);
        },
        () => {
          historyPendingRef.current--;
          if (historyPendingRef.current === 0) setHistoryBusy(false);
        },
      );
      historyQueueRef.current = cleanup;

      return task;
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

  if (path === "/members")
    return (
      <MembersView
        history={history}
        externalDataVersion={externalDataVersion}
      />
    );
  return (
    <CapacityView history={history} externalDataVersion={externalDataVersion} />
  );
}

export default App;
