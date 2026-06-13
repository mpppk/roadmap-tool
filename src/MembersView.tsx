import { useQueryClient } from "@tanstack/react-query";
import { GripVertical } from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "./capacity.css";
import {
  CapacityConflictPopover,
  type CapacityConflictResolution,
  MaxCapacityOverflowPopover,
  type RebalancePreview,
} from "@/shared/components/CapacityPopovers";
import { useQuarterRange, type ViewMode } from "@/shared/hooks/useQuarterRange";
import {
  type CapacityAggMode,
  fmt,
  heatBg,
  r2,
  readStoredCapacityAggMode,
} from "@/shared/utils/capacity-format";
import {
  isQuarterInRange,
  monthLabel,
  type QuarterYQ,
  quarterLabel,
  quartersInRange,
} from "@/shared/utils/quarter-utils";
import type { HistoryController } from "./history-client";
import {
  getNameErrorMessage,
  NAME_ERROR_MESSAGES,
  nextAvailableGeneratedName,
  trimSqliteSpaces,
} from "./name-errors";
import { navigate } from "./navigate";
import { orpc } from "./orpc-client";
import {
  queryKeys,
  useEpicsQuery,
  useInitiativesQuery,
  useMembersQuery,
  useMemberViewsQueries,
  useQuartersQuery,
} from "./queries";

// ── Types ──────────────────────────────────────────────────────────────────

type ImportMode = "append" | "sync";
type Month = { id: number; year: number; month: number; quarterId: number };
type Quarter = { id: number; year: number; quarter: number; months: Month[] };
type Member = { id: number; name: string; maxCapacity: number | null };
type Epic = { id: number; name: string; initiativeName: string | null };

type PendingCapacityConflict = {
  featureId: number;
  periodType: ViewMode;
  monthId?: number;
  quarterId?: number;
  memberId: number;
  memberName: string;
  requestedCapacity: number;
  usedElsewhere: number;
  assignableCapacity: number;
};

type PendingMaxCapacityOverflow = {
  featureId: number;
  periodType: ViewMode;
  monthId?: number;
  quarterId?: number;
  memberId: number;
  memberName: string;
  requestedCapacity: number;
  limit: number;
  usedElsewhere: number;
};

type MemberMonthData = {
  totalCapacity: number;
  featureAllocations: Array<{
    featureId: number;
    featureName: string;
    epicName: string | null;
    capacity: number;
  }>;
};

type MemberRow = {
  id: number;
  name: string;
  maxCapacity: number | null;
  expanded: boolean;
  months: Map<number, MemberMonthData>;
};

type PeriodColumn = {
  key: string;
  type: ViewMode;
  label: string;
  monthIds: number[];
  monthId?: number;
  quarterId?: number;
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function emptyMemberMonthData(): MemberMonthData {
  return { totalCapacity: 0, featureAllocations: [] };
}

function aggregateMemberMonthData(
  monthMap: Map<number, MemberMonthData>,
  monthIds: number[],
): MemberMonthData {
  const featureTotals = new Map<
    number,
    { featureName: string; epicName: string | null; capacity: number }
  >();
  let totalCapacity = 0;

  for (const monthId of monthIds) {
    const data = monthMap.get(monthId) ?? emptyMemberMonthData();
    totalCapacity += data.totalCapacity;
    for (const allocation of data.featureAllocations) {
      const current = featureTotals.get(allocation.featureId) ?? {
        featureName: allocation.featureName,
        epicName: allocation.epicName,
        capacity: 0,
      };
      featureTotals.set(allocation.featureId, {
        featureName: allocation.featureName,
        epicName: allocation.epicName,
        capacity: current.capacity + allocation.capacity,
      });
    }
  }

  return {
    totalCapacity,
    featureAllocations: [...featureTotals].map(([featureId, data]) => ({
      featureId,
      featureName: data.featureName,
      epicName: data.epicName,
      capacity: data.capacity,
    })),
  };
}

function columnsForMode(
  quarters: Quarter[],
  viewMode: ViewMode,
): PeriodColumn[] {
  if (viewMode === "quarter") {
    return quarters.map((q) => ({
      key: `q-${q.id}`,
      type: "quarter" as const,
      label: quarterLabel(q),
      monthIds: q.months.map((m) => m.id),
      quarterId: q.id,
    }));
  }

  return quarters.flatMap((q) =>
    q.months.map((m) => ({
      key: `m-${m.id}`,
      type: "month" as const,
      label: monthLabel(m),
      monthIds: [m.id],
      monthId: m.id,
    })),
  );
}

function columnMemberLimit(column: PeriodColumn, maxCapacity: number): number {
  return column.type === "quarter"
    ? column.monthIds.length * maxCapacity
    : maxCapacity;
}

// UI 専用の展開フラグ（Set）をトグルする。キャッシュデータには載せない。
function toggleInSet(set: Set<number>, id: number): Set<number> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

// ── Sub-components ──────────────────────────────────────────────────────────

function ReadonlyHeatmapCell({
  value,
  maxVal,
  rowHeight,
  isOverflow = false,
}: {
  value: number;
  maxVal: number;
  rowHeight: number;
  isOverflow?: boolean;
}) {
  const { bg, fg } = heatBg(value, maxVal);
  const ovBg = isOverflow ? "oklch(72% 0.18 25)" : bg;
  const ovFg = isOverflow ? "#fff" : fg;
  return (
    <div
      className="hm-cell"
      style={{ background: ovBg, height: rowHeight, cursor: "default" }}
    >
      <span
        className="hm-val"
        style={{ color: value === 0 ? "transparent" : ovFg }}
      >
        {fmt(value)}
      </span>
    </div>
  );
}

function MemberNameCell({
  member,
  onRename,
  onDelete,
}: {
  member: Member;
  onRename: (id: number, name: string) => Promise<string | undefined>;
  onDelete: (id: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(member.name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const committingRef = useRef(false);

  useEffect(() => {
    if (!editing) setVal(member.name);
  }, [editing, member.name]);

  const startEdit = () => {
    setVal(member.name);
    setError(null);
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 20);
  };

  const cancelEdit = () => {
    setVal(member.name);
    setError(null);
    setEditing(false);
  };

  const commit = async () => {
    if (committingRef.current) return;
    const trimmed = trimSqliteSpaces(val);
    if (trimmed.length === 0) {
      setError(NAME_ERROR_MESSAGES.blank);
      return;
    }
    if (trimmed === member.name) {
      cancelEdit();
      return;
    }

    committingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const savedName = await onRename(member.id, trimmed);
      setVal(savedName ?? trimmed);
      setEditing(false);
    } catch (error) {
      setError(getNameErrorMessage(error) ?? "保存できませんでした。");
    } finally {
      committingRef.current = false;
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="name-edit-row">
        <input
          ref={inputRef}
          className="feature-name-input"
          value={val}
          disabled={saving}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setVal(e.target.value);
            setError(null);
          }}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
            if (e.key === "Escape") cancelEdit();
          }}
        />
        {error && (
          <span className="name-warning" role="alert">
            {error}
          </span>
        )}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
      <button
        type="button"
        className="feature-name"
        onClick={startEdit}
        title="クリックで名前を編集"
      >
        {member.name}
      </button>
      <button
        type="button"
        className="del-member-btn"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(member.id);
        }}
        title="メンバーを削除"
      >
        ×
      </button>
    </div>
  );
}

function MaxCapacityCell({
  member,
  onSetMaxCapacity,
}: {
  member: Member;
  onSetMaxCapacity: (id: number, maxCapacity: number | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const committingRef = useRef(false);

  const displayValue =
    member.maxCapacity != null ? fmt(member.maxCapacity) : "–";

  const startEdit = () => {
    setVal(member.maxCapacity != null ? fmt(member.maxCapacity) : "");
    setError(null);
    setEditing(true);
    setTimeout(() => {
      inputRef.current?.select();
    }, 20);
  };

  const cancelEdit = () => {
    setError(null);
    setEditing(false);
  };

  const commit = async () => {
    if (committingRef.current) return;
    const trimmed = val.trim();
    const nextValue = trimmed === "" ? null : Number(trimmed);
    if (
      nextValue !== null &&
      (Number.isNaN(nextValue) || nextValue <= 0 || nextValue > 1)
    ) {
      setError("0より大きく1以下の値を入力してください");
      return;
    }
    if (nextValue === member.maxCapacity) {
      cancelEdit();
      return;
    }
    committingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await onSetMaxCapacity(member.id, nextValue);
      setEditing(false);
    } catch {
      setError("保存できませんでした。");
    } finally {
      committingRef.current = false;
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <input
          ref={inputRef}
          className="feature-name-input"
          style={{ width: 64, textAlign: "right" }}
          type="number"
          min="0.001"
          max="1"
          step="0.05"
          placeholder="1.0"
          value={val}
          disabled={saving}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setVal(e.target.value);
            setError(null);
          }}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
            if (e.key === "Escape") cancelEdit();
          }}
        />
        {error && (
          <span className="name-warning" role="alert" style={{ fontSize: 10 }}>
            {error}
          </span>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      className="feature-name"
      style={{ minWidth: 40, textAlign: "right" }}
      onClick={startEdit}
      title="クリックでMax Capacityを編集（空白でリセット）"
    >
      {displayValue}
    </button>
  );
}

function HeatmapEditableFeatureCell({
  value,
  maxVal,
  isOverflow,
  onCommit,
}: {
  value: number;
  maxVal: number;
  isOverflow: boolean;
  onCommit: (v: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { bg, fg } = heatBg(value, maxVal);
  const ovBg = isOverflow ? "oklch(72% 0.18 25)" : bg;
  const ovFg = isOverflow ? "#fff" : fg;

  const startEdit = () => {
    setEditVal(value === 0 ? "" : fmt(value));
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 20);
  };

  const commit = () => {
    const v = parseFloat(editVal);
    if (!Number.isNaN(v) && v >= 0) onCommit(r2(v));
    setEditing(false);
  };

  return (
    <button
      type="button"
      className="hm-member-cell"
      style={{ background: ovBg }}
      onClick={startEdit}
    >
      {editing ? (
        <input
          ref={inputRef}
          className="hm-input"
          value={editVal}
          placeholder="0"
          onChange={(e) => setEditVal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          onClick={(e) => e.stopPropagation()}
          style={{ color: ovFg }}
        />
      ) : (
        <span
          className="hm-member-val"
          style={{ color: value === 0 ? "transparent" : ovFg }}
        >
          {fmt(value)}
        </span>
      )}
    </button>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

const COL_W = 148;
const CAPACITY_AGG_MODE_STORAGE_KEY = "roadmap.membersView.capacityAggMode";

export function MembersView({ history }: { history: HistoryController }) {
  const queryClient = useQueryClient();
  const membersQuery = useMembersQuery();
  const quartersQuery = useQuartersQuery();
  const epicsQuery = useEpicsQuery();
  const initiativesQuery = useInitiativesQuery();
  const memberIds = useMemo(
    () => (membersQuery.data ?? []).map((m) => m.id),
    [membersQuery.data],
  );
  const memberViewsQueries = useMemberViewsQueries(memberIds);

  const {
    viewMode,
    setViewMode,
    rangeStart,
    setRangeStart,
    rangeEnd,
    setRangeEnd,
    rangeStartRef,
    rangeEndRef,
    rangeInitializedRef,
  } = useQuarterRange("roadmap.membersView");
  const [capacityAggMode, setCapacityAggMode] = useState<CapacityAggMode>(() =>
    readStoredCapacityAggMode(CAPACITY_AGG_MODE_STORAGE_KEY, "total"),
  );
  // UI 専用の展開フラグ（キャッシュには載せない）。空集合 = 全行折りたたみ。
  const [expandedMemberIds, setExpandedMemberIds] = useState<Set<number>>(
    () => new Set(),
  );
  const [draggingMemberId, setDraggingMemberId] = useState<number | null>(null);
  const [assigningMemberId, setAssigningMemberId] = useState<number | null>(
    null,
  );
  const [removeEpicConfirm, setRemoveEpicConfirm] = useState<{
    memberId: number;
    memberName: string;
    epicId: number;
    epicName: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionWarning, setActionWarning] = useState<string | null>(null);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importTsv, setImportTsv] = useState("");
  const [importMode, setImportMode] = useState<ImportMode>("append");
  const [importResult, setImportResult] = useState<{
    success: number;
    skipped: number;
    errors: { row: number; message: string }[];
  } | null>(null);
  const [importing, setImporting] = useState(false);
  const [importUnsavedWarning, setImportUnsavedWarning] = useState(false);
  const [capacityConflict, setCapacityConflict] =
    useState<PendingCapacityConflict | null>(null);
  const [maxCapacityOverflow, setMaxCapacityOverflow] =
    useState<PendingMaxCapacityOverflow | null>(null);

  const [labelWidth, setLabelWidth] = useState(220);
  const colResizeRef = useRef<{ startX: number; startWidth: number } | null>(
    null,
  );
  const startLabelColumnResize = useCallback(
    (e: ReactMouseEvent<HTMLElement>) => {
      e.preventDefault();
      e.stopPropagation();
      colResizeRef.current = {
        startX: e.clientX,
        startWidth: labelWidth,
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [labelWidth],
  );
  const renderLabelResizeBorder = () => (
    <button
      type="button"
      aria-label="Resize member name column"
      className="col-resize-border"
      tabIndex={-1}
      onMouseDown={startLabelColumnResize}
    />
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!colResizeRef.current) return;
      const delta = e.clientX - colResizeRef.current.startX;
      setLabelWidth(Math.max(80, colResizeRef.current.startWidth + delta));
    };
    const onMouseUp = () => {
      if (!colResizeRef.current) return;
      colResizeRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (colResizeRef.current) {
        colResizeRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
  }, []);

  // ── 派生ビューモデル（クエリデータ + UI フラグの合成） ─────────────────────
  const quarters = useMemo<Quarter[]>(
    () =>
      [...(quartersQuery.data ?? [])]
        .map((q) => ({
          ...q,
          months: [...q.months].sort((a, b) => a.month - b.month),
        }))
        .sort((a, b) => a.year - b.year || a.quarter - b.quarter),
    [quartersQuery.data],
  );

  const allEpics = useMemo<Epic[]>(() => {
    const initiativeMap = new Map(
      (initiativesQuery.data ?? []).map((i) => [i.id, i.name]),
    );
    return (epicsQuery.data ?? []).map((e) => ({
      id: e.id,
      name: e.name,
      initiativeName: e.initiativeId
        ? (initiativeMap.get(e.initiativeId) ?? null)
        : null,
    }));
  }, [epicsQuery.data, initiativesQuery.data]);

  const memberRows = useMemo<MemberRow[]>(() => {
    const viewByMemberId = new Map<
      number,
      Awaited<ReturnType<typeof orpc.allocations.getMemberView>>
    >();
    for (const q of memberViewsQueries) {
      if (q.data) viewByMemberId.set(q.data.member.id, q.data);
    }
    return (membersQuery.data ?? []).map((m) => {
      const mv = viewByMemberId.get(m.id);
      const monthMap = new Map<number, MemberMonthData>();
      if (mv) {
        for (const qd of mv.quarters) {
          for (const md of qd.months) {
            monthMap.set(md.month.id, {
              totalCapacity: md.totalCapacity,
              featureAllocations: md.epicAllocations.map((fa) => ({
                featureId: fa.epic.id,
                featureName: fa.epic.name,
                epicName: fa.epic.initiative?.name ?? null,
                capacity: fa.capacity,
              })),
            });
          }
        }
      }
      return {
        id: m.id,
        name: m.name,
        maxCapacity: m.maxCapacity ?? null,
        expanded: expandedMemberIds.has(m.id),
        months: monthMap,
      };
    });
  }, [membersQuery.data, memberViewsQueries, expandedMemberIds]);

  // 初回ロードのみ全画面ゲートを出す（isFetching ではなく isLoading を使う）。
  const loading =
    membersQuery.isLoading ||
    quartersQuery.isLoading ||
    epicsQuery.isLoading ||
    initiativesQuery.isLoading ||
    memberViewsQueries.some((q) => q.isLoading);

  // クォーター読み込み後、初回のみ表示レンジを初期化する。
  // biome-ignore lint/correctness/useExhaustiveDependencies: refs from useQuarterRange are stable; intentionally runs once when quarters first load
  useEffect(() => {
    if (rangeInitializedRef.current) return;
    if (quartersQuery.isLoading) return;
    rangeInitializedRef.current = true;
    if (rangeStartRef.current === null && rangeEndRef.current === null) {
      const first = quarters[0];
      const last = quarters[quarters.length - 1];
      if (first && last) {
        setRangeStart({ year: first.year, quarter: first.quarter });
        setRangeEnd({ year: last.year, quarter: last.quarter });
      } else {
        const now = new Date();
        const yr = now.getFullYear();
        const q = Math.ceil((now.getMonth() + 1) / 3) as 1 | 2 | 3 | 4;
        setRangeStart({ year: yr, quarter: q });
        setRangeEnd({ year: yr, quarter: q });
      }
    }
  }, [quarters, quartersQuery.isLoading]);

  const displayedQuarters = useMemo(() => {
    if (!rangeStart || !rangeEnd) return quarters;
    return quarters.filter((q) => isQuarterInRange(q, rangeStart, rangeEnd));
  }, [quarters, rangeStart, rangeEnd]);

  const yearOptions = useMemo(() => {
    const currentYear = new Date().getFullYear();
    const existing = quarters.map((q) => q.year);
    const base = Array.from({ length: 10 }, (_, i) => currentYear - 2 + i);
    return [...new Set([...existing, ...base])].sort((a, b) => a - b);
  }, [quarters]);

  const columns = useMemo(
    () => columnsForMode(displayedQuarters, viewMode),
    [displayedQuarters, viewMode],
  );

  useEffect(() => {
    try {
      localStorage.setItem(CAPACITY_AGG_MODE_STORAGE_KEY, capacityAggMode);
    } catch {}
  }, [capacityAggMode]);

  // ── Helpers ──────────────────────────────────────────────────────────────

  const colDivisor = (column: PeriodColumn): number =>
    capacityAggMode === "average" && column.type === "quarter"
      ? column.monthIds.length
      : 1;

  const getColumnData = (
    row: MemberRow,
    column: PeriodColumn,
  ): MemberMonthData => aggregateMemberMonthData(row.months, column.monthIds);

  const toggleExpand = (memberId: number) => {
    setExpandedMemberIds((prev) => toggleInSet(prev, memberId));
  };

  const expandAll = () => {
    setExpandedMemberIds(new Set((membersQuery.data ?? []).map((m) => m.id)));
  };

  const collapseAll = () => {
    setExpandedMemberIds(new Set());
  };

  // ── Allocation helpers ────────────────────────────────────────────────────

  const getRebalancePreview = useCallback(
    (
      member: MemberRow,
      column: PeriodColumn,
      excludeFeatureId: number,
      requestedCapacity: number,
    ): RebalancePreview[] => {
      const featureTotals = new Map<
        number,
        { featureName: string; capacity: number }
      >();
      for (const monthId of column.monthIds) {
        const monthData = member.months.get(monthId);
        if (!monthData) continue;
        for (const fa of monthData.featureAllocations) {
          if (fa.featureId === excludeFeatureId) continue;
          const current = featureTotals.get(fa.featureId) ?? {
            featureName: fa.featureName,
            capacity: 0,
          };
          featureTotals.set(fa.featureId, {
            featureName: current.featureName || fa.featureName,
            capacity: current.capacity + fa.capacity,
          });
        }
      }
      const otherAllocations = [...featureTotals.values()].filter(
        (f) => f.capacity > 0,
      );
      const usedElsewhere = otherAllocations.reduce(
        (sum, f) => sum + f.capacity,
        0,
      );
      const limit = columnMemberLimit(column, member.maxCapacity ?? 1);
      const scale =
        requestedCapacity <= limit && usedElsewhere > 0
          ? Math.max(0, (limit - requestedCapacity) / usedElsewhere)
          : 1;
      return otherAllocations.map((f) => ({
        featureName: f.featureName,
        currentCapacity: f.capacity,
        nextCapacity: r2(f.capacity * scale),
      }));
    },
    [],
  );

  const getRebalanceAllPreview = useCallback(
    (
      member: MemberRow,
      column: PeriodColumn,
      excludeFeatureId: number,
      requestedCapacity: number,
    ): { newCapacity: number; othersPreview: RebalancePreview[] } => {
      const featureTotals = new Map<
        number,
        { featureName: string; capacity: number }
      >();
      for (const monthId of column.monthIds) {
        const monthData = member.months.get(monthId);
        if (!monthData) continue;
        for (const fa of monthData.featureAllocations) {
          if (fa.featureId === excludeFeatureId) continue;
          const current = featureTotals.get(fa.featureId) ?? {
            featureName: fa.featureName,
            capacity: 0,
          };
          featureTotals.set(fa.featureId, {
            featureName: current.featureName || fa.featureName,
            capacity: current.capacity + fa.capacity,
          });
        }
      }
      const otherAllocations = [...featureTotals.values()].filter(
        (f) => f.capacity > 0,
      );
      const usedElsewhere = otherAllocations.reduce(
        (sum, f) => sum + f.capacity,
        0,
      );
      const limit = columnMemberLimit(column, member.maxCapacity ?? 1);
      const total = usedElsewhere + requestedCapacity;
      const scale = total > limit ? limit / total : 1;
      return {
        newCapacity: r2(requestedCapacity * scale),
        othersPreview: otherAllocations.map((f) => ({
          featureName: f.featureName,
          currentCapacity: f.capacity,
          nextCapacity: r2(f.capacity * scale),
        })),
      };
    },
    [],
  );

  const handleUpdateMemberAllocation = useCallback(
    async (
      featureId: number,
      member: MemberRow,
      column: PeriodColumn,
      capacity: number,
    ) => {
      setBusy(true);
      try {
        setCapacityConflict(null);
        setMaxCapacityOverflow(null);
        const limit = columnMemberLimit(column, member.maxCapacity ?? 1);

        if (capacity > limit) {
          const usedElsewhere = column.monthIds.reduce((sum, monthId) => {
            const monthData = member.months.get(monthId);
            return (
              sum +
              (monthData?.featureAllocations
                .filter((a) => a.featureId !== featureId)
                .reduce((s, a) => s + a.capacity, 0) ?? 0)
            );
          }, 0);
          setMaxCapacityOverflow({
            featureId,
            periodType: column.type,
            monthId: column.monthId,
            quarterId: column.quarterId,
            memberId: member.id,
            memberName: member.name,
            requestedCapacity: capacity,
            limit,
            usedElsewhere,
          });
          return;
        }

        const preview = await orpc.allocations.previewMemberAllocation({
          epicId: featureId,
          memberId: member.id,
          capacity,
          periodType: column.type,
          monthId: column.monthId,
          quarterId: column.quarterId,
        });
        if (preview.hasConflict) {
          setCapacityConflict({
            featureId,
            periodType: column.type,
            monthId: column.monthId,
            quarterId: column.quarterId,
            memberId: member.id,
            memberName: member.name,
            requestedCapacity: capacity,
            usedElsewhere: preview.usedElsewhere,
            assignableCapacity: preview.assignableCapacity,
          });
          return;
        }

        await history.record("Member capacityを変更", async () => {
          await orpc.allocations.updateMemberAllocation({
            epicId: featureId,
            memberId: member.id,
            capacity,
            periodType: column.type,
            monthId: column.monthId,
            quarterId: column.quarterId,
            capacityConflictResolution: "fitWithinLimit",
          });
          // rebalance 系の解決は他メンバーにも波及しうるため memberView 全体を無効化。
          await queryClient.invalidateQueries({ queryKey: ["memberView"] });
        });
      } finally {
        setBusy(false);
      }
    },
    [history, queryClient],
  );

  const resolveCapacityConflict = useCallback(
    async (resolution: CapacityConflictResolution) => {
      if (!capacityConflict) return;
      setBusy(true);
      try {
        await history.record("Capacity競合を解決", async () => {
          await orpc.allocations.updateMemberAllocation({
            epicId: capacityConflict.featureId,
            periodType: capacityConflict.periodType,
            monthId: capacityConflict.monthId,
            quarterId: capacityConflict.quarterId,
            memberId: capacityConflict.memberId,
            capacity: capacityConflict.requestedCapacity,
            capacityConflictResolution: resolution,
          });
          await queryClient.invalidateQueries({ queryKey: ["memberView"] });
        });
        setCapacityConflict(null);
      } finally {
        setBusy(false);
      }
    },
    [capacityConflict, history, queryClient],
  );

  const resolveMaxCapacityOverflow = useCallback(
    async (resolution: "fitWithinLimit" | "allowOverflow") => {
      if (!maxCapacityOverflow) return;
      setBusy(true);
      try {
        await history.record("Max capacity超過を解決", async () => {
          await orpc.allocations.updateMemberAllocation({
            epicId: maxCapacityOverflow.featureId,
            periodType: maxCapacityOverflow.periodType,
            monthId: maxCapacityOverflow.monthId,
            quarterId: maxCapacityOverflow.quarterId,
            memberId: maxCapacityOverflow.memberId,
            capacity: maxCapacityOverflow.requestedCapacity,
            capacityConflictResolution: resolution,
          });
          await queryClient.invalidateQueries({ queryKey: ["memberView"] });
        });
        setMaxCapacityOverflow(null);
      } finally {
        setBusy(false);
      }
    },
    [history, maxCapacityOverflow, queryClient],
  );

  // ── API actions ───────────────────────────────────────────────────────────

  const addMember = async () => {
    setBusy(true);
    setActionWarning(null);
    try {
      const m = await history.record("Memberを追加", async () => {
        return orpc.members.create({
          name: nextAvailableGeneratedName(
            "Member",
            memberRows.map((row) => row.name),
          ),
        });
      });
      if (!m) return;
      await queryClient.invalidateQueries({ queryKey: queryKeys.members() });
    } catch (error) {
      const message = getNameErrorMessage(error);
      if (message) setActionWarning(message);
      else throw error;
    } finally {
      setBusy(false);
    }
  };

  const renameMember = useCallback(
    async (id: number, name: string) => {
      const m = await history.record("Member名を変更", async () => {
        return orpc.members.rename({ id, name });
      });
      if (!m) return name;
      await queryClient.invalidateQueries({ queryKey: queryKeys.members() });
      return m.name;
    },
    [history, queryClient],
  );

  const deleteMember = useCallback(
    async (id: number) => {
      setBusy(true);
      try {
        await history.record("Memberを削除", async () => {
          await orpc.members.delete({ id });
          await queryClient.invalidateQueries({
            queryKey: queryKeys.members(),
          });
        });
        queryClient.removeQueries({ queryKey: queryKeys.memberView(id) });
      } finally {
        setBusy(false);
      }
    },
    [history, queryClient],
  );

  const moveMember = useCallback(
    async (memberId: number, targetId: number) => {
      if (memberId === targetId) return;
      const memberIndex = memberRows.findIndex((r) => r.id === memberId);
      const targetIndex = memberRows.findIndex((r) => r.id === targetId);
      const draggingDown = memberIndex < targetIndex;
      await orpc.members.move(
        draggingDown
          ? { id: memberId, afterId: targetId }
          : { id: memberId, beforeId: targetId },
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.members() });
    },
    [memberRows, queryClient],
  );

  const setMaxCapacity = useCallback(
    async (id: number, maxCapacity: number | null) => {
      await history.record("Max capacityを変更", async () => {
        await orpc.members.setMaxCapacity({ id, maxCapacity });
        await queryClient.invalidateQueries({ queryKey: queryKeys.members() });
      });
    },
    [history, queryClient],
  );

  const assignEpicToMember = useCallback(
    async (memberId: number, epicId: number) => {
      setBusy(true);
      try {
        await history.record("EpicをMemberに割り当て", async () => {
          await orpc.allocations.assignMember({ epicId, memberId });
          await queryClient.invalidateQueries({
            queryKey: queryKeys.memberView(memberId),
          });
        });
      } finally {
        setBusy(false);
      }
    },
    [history, queryClient],
  );

  const removeEpicFromMember = useCallback(
    async (memberId: number, epicId: number) => {
      setBusy(true);
      try {
        await history.record("EpicをMemberから削除", async () => {
          await orpc.allocations.removeMemberFromEpic({ epicId, memberId });
          await queryClient.invalidateQueries({
            queryKey: queryKeys.memberView(memberId),
          });
        });
      } finally {
        setBusy(false);
        setRemoveEpicConfirm(null);
      }
    },
    [history, queryClient],
  );

  const runImportTSV = useCallback(async () => {
    setImporting(true);
    try {
      const result = await history.record(
        importMode === "sync" ? "Member TSVを同期" : "Member TSVを追記",
        async () =>
          orpc.import.memberTSVImport({ tsv: importTsv, mode: importMode }),
      );
      setImportResult(result);
      await queryClient.invalidateQueries();
    } catch (error) {
      setImportResult({
        success: 0,
        skipped: 0,
        errors: [
          {
            row: 0,
            message:
              error instanceof Error
                ? error.message
                : "インポートに失敗しました",
          },
        ],
      });
    } finally {
      setImporting(false);
    }
  }, [history, importMode, importTsv, queryClient]);

  const applyRange = async (start: QuarterYQ, end: QuarterYQ) => {
    if (start.year * 4 + start.quarter > end.year * 4 + end.quarter) return;
    setRangeStart(start);
    setRangeEnd(end);

    const needed = quartersInRange(start, end);
    const missing = needed.filter(
      (yq) =>
        !quarters.some((q) => q.year === yq.year && q.quarter === yq.quarter),
    );
    if (missing.length === 0) return;

    setBusy(true);
    try {
      const created = await history.record("表示期間を変更", async () =>
        Promise.all(
          missing.map((yq) =>
            orpc.quarters.create({ year: yq.year, quarter: yq.quarter }),
          ),
        ),
      );
      if (!created) return;
      await queryClient.invalidateQueries({ queryKey: queryKeys.quarters() });
    } finally {
      setBusy(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="cv-root">
        <header className="cv-header">
          <h1>Roadmap</h1>
          <span className="sep">›</span>
          <nav className="cv-nav">
            <button
              type="button"
              className="cv-nav-link"
              onClick={() => navigate("/features")}
            >
              Epics
            </button>
            <button
              type="button"
              className="cv-nav-link active"
              onClick={() => navigate("/members")}
            >
              Members
            </button>
            <button
              type="button"
              className="cv-nav-link"
              onClick={() => navigate("/strategy")}
            >
              Strategy
            </button>
          </nav>
        </header>
        <div className="cv-loading">読み込み中…</div>
      </div>
    );
  }

  return (
    <div
      className="cv-root"
      style={{ "--col-label": `${labelWidth}px` } as React.CSSProperties}
    >
      <header className="cv-header">
        <h1>Roadmap</h1>
        <span className="sep">›</span>
        <nav className="cv-nav">
          <button
            type="button"
            className="cv-nav-link"
            onClick={() => navigate("/features")}
          >
            Epics
          </button>
          <button
            type="button"
            className="cv-nav-link active"
            onClick={() => navigate("/members")}
          >
            Members
          </button>
          <button
            type="button"
            className="cv-nav-link"
            onClick={() => navigate("/strategy")}
          >
            Strategy
          </button>
        </nav>
        {history.controls}
        <fieldset className="period-toggle">
          <legend className="period-toggle-label">表示単位</legend>
          <button
            type="button"
            className={`period-toggle-btn${viewMode === "quarter" ? " active" : ""}`}
            onClick={() => setViewMode("quarter")}
          >
            Quarter
          </button>
          <button
            type="button"
            className={`period-toggle-btn${viewMode === "month" ? " active" : ""}`}
            onClick={() => setViewMode("month")}
          >
            Month
          </button>
        </fieldset>
        {viewMode === "quarter" && (
          <fieldset className="period-toggle">
            <legend className="period-toggle-label">集計</legend>
            <button
              type="button"
              className={`period-toggle-btn${capacityAggMode === "total" ? " active" : ""}`}
              onClick={() => setCapacityAggMode("total")}
            >
              合計
            </button>
            <button
              type="button"
              className={`period-toggle-btn${capacityAggMode === "average" ? " active" : ""}`}
              onClick={() => setCapacityAggMode("average")}
            >
              月平均
            </button>
          </fieldset>
        )}
        <fieldset className="period-toggle">
          <legend className="period-toggle-label">表示期間</legend>
          <select
            value={rangeStart?.year ?? new Date().getFullYear()}
            disabled={busy}
            onChange={(e) => {
              const yr = Number(e.target.value);
              void applyRange(
                { year: yr, quarter: rangeStart?.quarter ?? 1 },
                rangeEnd ?? { year: yr, quarter: 4 },
              );
            }}
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <select
            value={rangeStart?.quarter ?? 1}
            disabled={busy}
            onChange={(e) => {
              const q = Number(e.target.value) as 1 | 2 | 3 | 4;
              void applyRange(
                {
                  year: rangeStart?.year ?? new Date().getFullYear(),
                  quarter: q,
                },
                rangeEnd ?? {
                  year: rangeStart?.year ?? new Date().getFullYear(),
                  quarter: 4,
                },
              );
            }}
          >
            <option value={1}>Q1</option>
            <option value={2}>Q2</option>
            <option value={3}>Q3</option>
            <option value={4}>Q4</option>
          </select>
          <span style={{ fontSize: 11, color: "var(--cv-text-3)" }}>〜</span>
          <select
            value={rangeEnd?.year ?? new Date().getFullYear()}
            disabled={busy}
            onChange={(e) => {
              const yr = Number(e.target.value);
              void applyRange(rangeStart ?? { year: yr, quarter: 1 }, {
                year: yr,
                quarter: rangeEnd?.quarter ?? 4,
              });
            }}
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <select
            value={rangeEnd?.quarter ?? 4}
            disabled={busy}
            onChange={(e) => {
              const q = Number(e.target.value) as 1 | 2 | 3 | 4;
              void applyRange(
                rangeStart ?? {
                  year: rangeEnd?.year ?? new Date().getFullYear(),
                  quarter: 1,
                },
                {
                  year: rangeEnd?.year ?? new Date().getFullYear(),
                  quarter: q,
                },
              );
            }}
          >
            <option value={1}>Q1</option>
            <option value={2}>Q2</option>
            <option value={3}>Q3</option>
            <option value={4}>Q4</option>
          </select>
        </fieldset>
        <fieldset className="period-toggle">
          <legend className="period-toggle-label">展開</legend>
          <button
            type="button"
            className="period-toggle-btn"
            onClick={expandAll}
          >
            すべて展開
          </button>
          <button
            type="button"
            className="period-toggle-btn"
            onClick={collapseAll}
          >
            すべて折りたたむ
          </button>
        </fieldset>
        {busy && (
          <span
            style={{ marginLeft: 8, fontSize: 11, color: "var(--cv-text-3)" }}
          >
            保存中…
          </span>
        )}
      </header>

      <div className="cv-body">
        <div className="cv-table-wrapper">
          <table className="cv-table">
            <thead>
              <tr>
                <th className="th-label">Member</th>
                <th
                  className="th-quarter"
                  style={{ width: 80, minWidth: 80, textAlign: "right" }}
                  title="月あたりの最大キャパシティ（未設定時は1.0）"
                >
                  Max Cap
                </th>
                {columns.map((column) => (
                  <th
                    key={column.key}
                    className="th-quarter"
                    style={{ width: COL_W, minWidth: COL_W }}
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {memberRows.map((member, mi) => {
                const rows: React.ReactNode[] = [];

                if (mi > 0) {
                  rows.push(
                    <tr key={`sep-${member.id}`} className="cv-section-sep">
                      <td colSpan={columns.length + 1} />
                    </tr>,
                  );
                }

                const memberMaxCap = member.maxCapacity ?? 1;
                rows.push(
                  <tr
                    key={member.id}
                    className="tr-feature"
                    onDragOver={(e) => {
                      if (draggingMemberId) e.preventDefault();
                    }}
                    onDrop={() => {
                      if (draggingMemberId && draggingMemberId !== member.id) {
                        void moveMember(draggingMemberId, member.id);
                      }
                    }}
                  >
                    <td className="td-label">
                      <div className="td-label-inner">
                        <button
                          type="button"
                          className="drag-handle"
                          draggable
                          onDragStart={() => setDraggingMemberId(member.id)}
                          onDragEnd={() => setDraggingMemberId(null)}
                        >
                          <GripVertical size={14} />
                        </button>
                        <button
                          type="button"
                          className="toggle-btn"
                          onClick={() => toggleExpand(member.id)}
                          title={member.expanded ? "折りたたむ" : "詳細を展開"}
                        >
                          {member.expanded ? "−" : "+"}
                        </button>
                        <MemberNameCell
                          member={member}
                          onRename={renameMember}
                          onDelete={deleteMember}
                        />
                      </div>
                      {renderLabelResizeBorder()}
                    </td>
                    <td
                      className="td-quarter"
                      style={{ width: 80, minWidth: 80, padding: "0 8px" }}
                    >
                      <MaxCapacityCell
                        member={member}
                        onSetMaxCapacity={setMaxCapacity}
                      />
                    </td>
                    {columns.map((column) => {
                      const data = getColumnData(member, column);
                      const limit = columnMemberLimit(column, memberMaxCap);
                      const cellOv = data.totalCapacity > limit + 0.000001;
                      const div = colDivisor(column);
                      return (
                        <td
                          key={column.key}
                          className="td-quarter"
                          style={{ width: COL_W, minWidth: COL_W }}
                        >
                          <ReadonlyHeatmapCell
                            value={data.totalCapacity / div}
                            maxVal={limit / div}
                            rowHeight={42}
                            isOverflow={cellOv}
                          />
                        </td>
                      );
                    })}
                  </tr>,
                );

                if (member.expanded) {
                  const featureMap = new Map<
                    number,
                    { featureName: string; epicName: string | null }
                  >();
                  for (const monthData of member.months.values()) {
                    for (const fa of monthData.featureAllocations) {
                      featureMap.set(fa.featureId, {
                        featureName: fa.featureName,
                        epicName: fa.epicName,
                      });
                    }
                  }

                  const assignedEpicIds = new Set(featureMap.keys());
                  const unassignedEpics = allEpics.filter(
                    (e) => !assignedEpicIds.has(e.id),
                  );

                  if (featureMap.size === 0) {
                    rows.push(
                      <tr key={`${member.id}-empty`} className="tr-member">
                        <td
                          className="td-label td-member-label"
                          colSpan={columns.length + 2}
                          style={{
                            color: "var(--cv-text-3)",
                            fontStyle: "italic",
                            fontSize: 12,
                          }}
                        >
                          アサインなし
                        </td>
                      </tr>,
                    );
                  } else {
                    for (const [featureId, featureInfo] of featureMap) {
                      const matchingCapacityConflict =
                        capacityConflict?.featureId === featureId &&
                        capacityConflict.memberId === member.id
                          ? capacityConflict
                          : null;
                      const matchingMaxCapacityOverflow =
                        maxCapacityOverflow?.featureId === featureId &&
                        maxCapacityOverflow.memberId === member.id
                          ? maxCapacityOverflow
                          : null;
                      rows.push(
                        <tr
                          key={`${member.id}-${featureId}`}
                          className="tr-member"
                        >
                          <td className="td-label td-member-label">
                            <span className="member-name">
                              <span className="feature-name-row">
                                <button
                                  type="button"
                                  className="feature-link-btn"
                                  onClick={() =>
                                    navigate(
                                      `/features?featureId=${featureId}&memberId=${member.id}`,
                                    )
                                  }
                                  title="Epics画面でこのメンバー行を表示"
                                >
                                  {featureInfo.featureName}
                                </button>
                                <button
                                  type="button"
                                  className="del-member-btn"
                                  title="このEpicの割り当てを削除"
                                  disabled={busy}
                                  onClick={() =>
                                    setRemoveEpicConfirm({
                                      memberId: member.id,
                                      memberName: member.name,
                                      epicId: featureId,
                                      epicName: featureInfo.featureName,
                                    })
                                  }
                                >
                                  ×
                                </button>
                              </span>
                              {featureInfo.epicName && (
                                <span className="member-feature-epic">
                                  {featureInfo.epicName}
                                </span>
                              )}
                            </span>
                            {renderLabelResizeBorder()}
                          </td>
                          <td style={{ width: 80, minWidth: 80 }} />
                          {columns.map((column) => {
                            const data = getColumnData(member, column);
                            const fa = data.featureAllocations.find(
                              (a) => a.featureId === featureId,
                            );
                            const limit = columnMemberLimit(
                              column,
                              memberMaxCap,
                            );
                            const cellOv =
                              data.totalCapacity > limit + 0.000001;
                            const div = colDivisor(column);
                            const rawValue =
                              matchingCapacityConflict?.periodType ===
                                column.type &&
                              matchingCapacityConflict?.monthId ===
                                column.monthId &&
                              matchingCapacityConflict?.quarterId ===
                                column.quarterId
                                ? matchingCapacityConflict.requestedCapacity
                                : matchingMaxCapacityOverflow?.periodType ===
                                      column.type &&
                                    matchingMaxCapacityOverflow?.monthId ===
                                      column.monthId &&
                                    matchingMaxCapacityOverflow?.quarterId ===
                                      column.quarterId
                                  ? matchingMaxCapacityOverflow.requestedCapacity
                                  : (fa?.capacity ?? 0);
                            const displayValue = rawValue / div;
                            const displayLimit = limit / div;
                            const isConflictCell =
                              (!!matchingCapacityConflict &&
                                matchingCapacityConflict.periodType ===
                                  column.type &&
                                matchingCapacityConflict.monthId ===
                                  column.monthId &&
                                matchingCapacityConflict.quarterId ===
                                  column.quarterId) ||
                              (!!matchingMaxCapacityOverflow &&
                                matchingMaxCapacityOverflow.periodType ===
                                  column.type &&
                                matchingMaxCapacityOverflow.monthId ===
                                  column.monthId &&
                                matchingMaxCapacityOverflow.quarterId ===
                                  column.quarterId);
                            const isOverflow = cellOv || isConflictCell;
                            return (
                              <td
                                key={column.key}
                                className="td-member-val"
                                style={{ width: COL_W, padding: 0 }}
                              >
                                <HeatmapEditableFeatureCell
                                  value={displayValue}
                                  maxVal={displayLimit}
                                  isOverflow={isOverflow}
                                  onCommit={(v) =>
                                    void handleUpdateMemberAllocation(
                                      featureId,
                                      member,
                                      column,
                                      v * div,
                                    )
                                  }
                                />
                                {matchingMaxCapacityOverflow &&
                                  matchingMaxCapacityOverflow.periodType ===
                                    column.type &&
                                  matchingMaxCapacityOverflow.monthId ===
                                    column.monthId &&
                                  matchingMaxCapacityOverflow.quarterId ===
                                    column.quarterId && (
                                    <MaxCapacityOverflowPopover
                                      memberName={
                                        matchingMaxCapacityOverflow.memberName
                                      }
                                      limit={matchingMaxCapacityOverflow.limit}
                                      requestedCapacity={
                                        matchingMaxCapacityOverflow.requestedCapacity
                                      }
                                      usedElsewhere={
                                        matchingMaxCapacityOverflow.usedElsewhere
                                      }
                                      onResolve={resolveMaxCapacityOverflow}
                                      onCancel={() =>
                                        setMaxCapacityOverflow(null)
                                      }
                                      displayDivisor={div}
                                    />
                                  )}
                                {matchingCapacityConflict &&
                                  matchingCapacityConflict.periodType ===
                                    column.type &&
                                  matchingCapacityConflict.monthId ===
                                    column.monthId &&
                                  matchingCapacityConflict.quarterId ===
                                    column.quarterId && (
                                    <CapacityConflictPopover
                                      memberName={
                                        matchingCapacityConflict.memberName
                                      }
                                      usedElsewhere={
                                        matchingCapacityConflict.usedElsewhere
                                      }
                                      assignableCapacity={
                                        matchingCapacityConflict.assignableCapacity
                                      }
                                      requestedCapacity={
                                        matchingCapacityConflict.requestedCapacity
                                      }
                                      rebalancePreview={getRebalancePreview(
                                        member,
                                        column,
                                        matchingCapacityConflict.featureId,
                                        matchingCapacityConflict.requestedCapacity,
                                      )}
                                      rebalanceAllPreview={getRebalanceAllPreview(
                                        member,
                                        column,
                                        matchingCapacityConflict.featureId,
                                        matchingCapacityConflict.requestedCapacity,
                                      )}
                                      onResolve={resolveCapacityConflict}
                                      onCancel={() => setCapacityConflict(null)}
                                      displayDivisor={div}
                                    />
                                  )}
                              </td>
                            );
                          })}
                        </tr>,
                      );
                    }
                  }

                  rows.push(
                    <tr
                      key={`${member.id}-assign-epic`}
                      className="tr-assign-member"
                    >
                      <td className="td-assign td-assign-member">
                        {assigningMemberId === member.id ? (
                          <select
                            className="assign-select"
                            // biome-ignore lint/a11y/noAutofocus: intentional focus for inline dropdown
                            autoFocus
                            defaultValue=""
                            onChange={(e) => {
                              const id = Number(e.target.value);
                              if (id) void assignEpicToMember(member.id, id);
                              setAssigningMemberId(null);
                            }}
                            onBlur={() => setAssigningMemberId(null)}
                          >
                            <option value="" disabled>
                              -- Epicを選択 --
                            </option>
                            {unassignedEpics.map((e) => (
                              <option key={e.id} value={e.id}>
                                {e.name}
                                {e.initiativeName
                                  ? ` (${e.initiativeName})`
                                  : ""}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <button
                            type="button"
                            className="btn-assign"
                            disabled={busy || unassignedEpics.length === 0}
                            onClick={() => setAssigningMemberId(member.id)}
                          >
                            + Epicを割り当て
                          </button>
                        )}
                      </td>
                      <td style={{ width: 80, minWidth: 80 }} />
                      {columns.map((column) => (
                        <td
                          key={column.key}
                          className="td-quarter"
                          style={{ width: COL_W, minWidth: COL_W }}
                        />
                      ))}
                    </tr>,
                  );
                }

                return rows;
              })}
            </tbody>
          </table>
        </div>

        <div className="cv-toolbar">
          <button
            type="button"
            className="btn-sm"
            onClick={addMember}
            disabled={busy}
          >
            + Member
          </button>
          <button
            type="button"
            className="btn-sm"
            onClick={() => {
              setImportTsv("");
              setImportMode("append");
              setImportResult(null);
              setImportModalOpen(true);
            }}
            title="TSVをインポート（id/member_id, name, max_capacity）"
          >
            TSVをインポート
          </button>
          {(actionWarning || history.warning) && (
            <span className="name-action-warning" role="alert">
              {actionWarning || history.warning}
            </span>
          )}
          <span className="hint-text">+ でFeature展開</span>
        </div>
      </div>

      {importModalOpen && (
        // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop closes on click; keyboard handled by dialog via Escape
        // biome-ignore lint/a11y/useKeyWithClickEvents: modal backdrop closes on click; keyboard handled by dialog via Escape
        <div
          className="confirm-overlay"
          onClick={() => {
            if (importing) return;
            if (importTsv.trim() && !importResult) {
              setImportUnsavedWarning(true);
            } else {
              setImportModalOpen(false);
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="confirm-dialog import-dialog"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape" && !importing) {
                if (importTsv.trim() && !importResult) {
                  setImportUnsavedWarning(true);
                } else {
                  setImportModalOpen(false);
                }
              }
            }}
          >
            <p className="confirm-msg">TSVをインポート</p>
            <p className="import-hint">
              ヘッダー行（name、任意でid/member_id、max_capacity）を含むTSVを貼り付けてください。
            </p>
            {!importResult ? (
              <>
                <fieldset className="period-toggle">
                  <legend className="period-toggle-label">
                    インポートモード
                  </legend>
                  <button
                    type="button"
                    className={`period-toggle-btn${importMode === "append" ? " active" : ""}`}
                    onClick={() => setImportMode("append")}
                    disabled={importing}
                  >
                    追記
                  </button>
                  <button
                    type="button"
                    className={`period-toggle-btn${importMode === "sync" ? " active" : ""}`}
                    onClick={() => setImportMode("sync")}
                    disabled={importing}
                    title="TSVに載っていないMemberを削除します"
                  >
                    同期
                  </button>
                </fieldset>
                <textarea
                  className="import-textarea"
                  value={importTsv}
                  onChange={(e) => {
                    setImportTsv(e.target.value);
                    setImportUnsavedWarning(false);
                  }}
                  placeholder={
                    "id\tname\tmax_capacity\n1\tAlice\t0.8\n2\tBob\t1"
                  }
                  disabled={importing}
                />
              </>
            ) : (
              <div className="import-result">
                <p>
                  完了: <strong>{importResult.success}件成功</strong>
                  {importResult.skipped > 0 &&
                    `、${importResult.skipped}件スキップ`}
                </p>
                {importResult.errors.length > 0 && (
                  <ul className="import-errors">
                    {importResult.errors.map((e) => (
                      <li key={e.row}>
                        {e.row > 0 ? `行${e.row}: ` : ""}
                        {e.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {importUnsavedWarning && (
              <span className="name-warning feature-details-error" role="alert">
                未保存の変更があります。インポートするか、キャンセルボタンを押して閉じてください。
              </span>
            )}
            <div className="confirm-actions">
              <button
                type="button"
                className="btn-sm"
                onClick={() => setImportModalOpen(false)}
                disabled={importing}
              >
                {importResult ? "閉じる" : "キャンセル"}
              </button>
              {!importResult && (
                <button
                  type="button"
                  className="btn-sm btn-primary"
                  onClick={runImportTSV}
                  disabled={importing || !importTsv.trim()}
                >
                  {importing ? "インポート中…" : "インポート"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {removeEpicConfirm && (
        // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop closes on click
        // biome-ignore lint/a11y/useKeyWithClickEvents: modal backdrop closes on click
        <div
          className="confirm-overlay"
          onClick={() => setRemoveEpicConfirm(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="confirm-dialog"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") setRemoveEpicConfirm(null);
            }}
          >
            <p className="confirm-msg">
              「{removeEpicConfirm.memberName}」から「
              {removeEpicConfirm.epicName}」の割り当てを削除しますか？
            </p>
            <div className="confirm-actions">
              <button
                type="button"
                className="btn-sm btn-danger"
                onClick={() =>
                  void removeEpicFromMember(
                    removeEpicConfirm.memberId,
                    removeEpicConfirm.epicId,
                  )
                }
              >
                削除
              </button>
              <button
                type="button"
                className="btn-sm"
                onClick={() => setRemoveEpicConfirm(null)}
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
