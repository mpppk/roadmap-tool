import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";
import type { QuarterYQ } from "@/shared/utils/quarter-utils";

export type ViewMode = "quarter" | "month";

export function useQuarterRange(storageKeyPrefix: string): {
  viewMode: ViewMode;
  setViewMode: Dispatch<SetStateAction<ViewMode>>;
  rangeStart: QuarterYQ | null;
  setRangeStart: Dispatch<SetStateAction<QuarterYQ | null>>;
  rangeEnd: QuarterYQ | null;
  setRangeEnd: Dispatch<SetStateAction<QuarterYQ | null>>;
  rangeStartRef: RefObject<QuarterYQ | null>;
  rangeEndRef: RefObject<QuarterYQ | null>;
  rangeInitializedRef: RefObject<boolean>;
} {
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const v = localStorage.getItem(`${storageKeyPrefix}.viewMode`);
      if (v === "quarter" || v === "month") return v;
    } catch {}
    return "quarter";
  });

  const [rangeStart, setRangeStart] = useState<QuarterYQ | null>(() => {
    try {
      const v = localStorage.getItem(`${storageKeyPrefix}.rangeStart`);
      return v ? (JSON.parse(v) as QuarterYQ) : null;
    } catch {}
    return null;
  });

  const [rangeEnd, setRangeEnd] = useState<QuarterYQ | null>(() => {
    try {
      const v = localStorage.getItem(`${storageKeyPrefix}.rangeEnd`);
      return v ? (JSON.parse(v) as QuarterYQ) : null;
    } catch {}
    return null;
  });

  const rangeInitializedRef = useRef(false);
  const rangeStartRef = useRef(rangeStart);
  rangeStartRef.current = rangeStart;
  const rangeEndRef = useRef(rangeEnd);
  rangeEndRef.current = rangeEnd;

  useEffect(() => {
    try {
      localStorage.setItem(`${storageKeyPrefix}.viewMode`, viewMode);
    } catch {}
  }, [storageKeyPrefix, viewMode]);

  useEffect(() => {
    try {
      if (rangeStart !== null)
        localStorage.setItem(
          `${storageKeyPrefix}.rangeStart`,
          JSON.stringify(rangeStart),
        );
    } catch {}
  }, [storageKeyPrefix, rangeStart]);

  useEffect(() => {
    try {
      if (rangeEnd !== null)
        localStorage.setItem(
          `${storageKeyPrefix}.rangeEnd`,
          JSON.stringify(rangeEnd),
        );
    } catch {}
  }, [storageKeyPrefix, rangeEnd]);

  return {
    viewMode,
    setViewMode,
    rangeStart,
    setRangeStart,
    rangeEnd,
    setRangeEnd,
    rangeStartRef,
    rangeEndRef,
    rangeInitializedRef,
  };
}
