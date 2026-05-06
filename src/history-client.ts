import type { ReactNode } from "react";
import type { orpc } from "./orpc-client";

export type RoadmapSnapshot = Awaited<ReturnType<typeof orpc.history.snapshot>>;

export type HistoryController = {
  canUndo: boolean;
  canRedo: boolean;
  busy: boolean;
  warning: string | null;
  version: number;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  clear: () => void;
  clearWarning: () => void;
  record: <T>(label: string, operation: () => Promise<T>) => Promise<T>;
  controls: ReactNode;
};
