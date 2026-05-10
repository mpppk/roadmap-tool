import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "./capacity.css";
import type { HistoryController } from "./history-client";
import {
  getNameErrorMessage,
  NAME_ERROR_MESSAGES,
  nextAvailableGeneratedName,
  trimSqliteSpaces,
} from "./name-errors";
import { navigate } from "./navigate";
import { orpc } from "./orpc-client";

// ── Types ──────────────────────────────────────────────────────────────────

type ViewMode = "quarter" | "month";
type CapacityAggMode = "total" | "average";
type ImportMode = "append" | "sync";
type Month = { id: number; year: number; month: number; quarterId: number };
type Quarter = { id: number; year: number; quarter: number; months: Month[] };
type Member = { id: number; name: string; maxCapacity: number | null };

type CapacityConflictResolution =
  | "fitWithinLimit"
  | "allowOverflow"
  | "rebalanceOthersProportionally"
  | "rebalanceAllProportionally";

type RebalancePreview = {
  featureName: string;
  currentCapacity: number;
  nextCapacity: number;
};

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

function fmt(v: number): string {
  if (v === 0) return "0";
  return v % 1 === 0 ? v.toFixed(0) : v.toFixed(2).replace(/\.?0+$/, "");
}

function heatBg(value: number, maxVal: number): { bg: string; fg: string } {
  if (value <= 0) return { bg: "transparent", fg: "var(--cv-text-3)" };
  const t = Math.min(value / maxVal, 1);
  const L = Math.round(96 - t * 78);
  const bg = `oklch(${L}% 0.01 250)`;
  const fg = L < 52 ? "#fff" : "var(--cv-text)";
  return { bg, fg };
}

function quarterLabel(q: Quarter): string {
  return `${q.year} Q${q.quarter}`;
}

function monthLabel(month: Month): string {
  return `${month.year}-${String(month.month).padStart(2, "0")}`;
}

function nextQuarterYQ(qs: Quarter[]): { year: number; quarter: number } {
  const last = qs[qs.length - 1];
  if (!last) return { year: new Date().getFullYear(), quarter: 1 };
  if (last.quarter === 4) return { year: last.year + 1, quarter: 1 };
  return { year: last.year, quarter: last.quarter + 1 };
}

type QuarterYQ = { year: number; quarter: number };

function quartersInRange(start: QuarterYQ, end: QuarterYQ): QuarterYQ[] {
  const result: QuarterYQ[] = [];
  let { year, quarter } = start;
  const endKey = end.year * 4 + end.quarter;
  while (year * 4 + quarter <= endKey) {
    result.push({ year, quarter });
    if (quarter === 4) {
      year++;
      quarter = 1;
    } else {
      quarter++;
    }
  }
  return result;
}

function isQuarterInRange(
  q: QuarterYQ,
  start: QuarterYQ,
  end: QuarterYQ,
): boolean {
  const qKey = q.year * 4 + q.quarter;
  return (
    qKey >= start.year * 4 + start.quarter && qKey <= end.year * 4 + end.quarter
  );
}

function emptyMemberMonthData(): MemberMonthData {
  return { totalCapacity: 0, featureAllocations: [] };
}

const r2 = (v: number) => Math.round(v * 100) / 100;

function fmt2(v: number): string {
  return v.toFixed(2);
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

function MaxCapacityOverflowPopover({
  memberName,
  limit,
  requestedCapacity,
  usedElsewhere,
  onResolve,
  onCancel,
  displayDivisor = 1,
}: {
  memberName: string;
  limit: number;
  requestedCapacity: number;
  usedElsewhere: number;
  onResolve: (resolution: "fitWithinLimit" | "allowOverflow") => void;
  onCancel: () => void;
  displayDivisor?: number;
}) {
  const d = displayDivisor;
  const reducedValue = Math.max(0, limit - usedElsewhere);

  return (
    <div className="capacity-conflict-popover" role="dialog" aria-modal="false">
      <div className="capacity-conflict-lines">
        <div>
          {memberName}のmax capacity ({fmt2(limit / d)}) を超えています。
        </div>
        <div>今回の割り当てキャパシティ: {fmt2(requestedCapacity / d)}</div>
      </div>
      <div className="capacity-conflict-actions">
        <button
          type="button"
          className="btn-sm capacity-conflict-action-btn"
          onClick={() => onResolve("fitWithinLimit")}
        >
          {`縮小して設定 (${fmt2(reducedValue / d)})`}
        </button>
        <button
          type="button"
          className="btn-sm capacity-conflict-action-btn"
          onClick={() => onResolve("allowOverflow")}
        >
          {`max capacityを超えて設定 (${fmt2(requestedCapacity / d)})`}
        </button>
        <button
          type="button"
          className="btn-sm capacity-conflict-action-btn"
          onClick={onCancel}
        >
          キャンセル
        </button>
      </div>
    </div>
  );
}

function CapacityConflictPopover({
  memberName,
  usedElsewhere,
  assignableCapacity,
  requestedCapacity,
  rebalancePreview,
  rebalanceAllPreview,
  onResolve,
  onCancel,
  displayDivisor = 1,
}: {
  memberName: string;
  usedElsewhere: number;
  assignableCapacity: number;
  requestedCapacity: number;
  rebalancePreview: RebalancePreview[];
  rebalanceAllPreview: {
    newCapacity: number;
    othersPreview: RebalancePreview[];
  };
  onResolve: (resolution: CapacityConflictResolution) => void;
  onCancel: () => void;
  displayDivisor?: number;
}) {
  const d = displayDivisor;
  const overflowTotal = usedElsewhere + requestedCapacity;

  return (
    <div className="capacity-conflict-popover" role="dialog" aria-modal="false">
      <div className="capacity-conflict-lines">
        <div>{memberName}の合計キャパシティが1を超えています。</div>
        <div>割り当て済み: {fmt2(usedElsewhere / d)}</div>
        <div>残りキャパシティ: {fmt2(assignableCapacity / d)}</div>
        <div>今回の割り当てキャパシティ: {fmt2(requestedCapacity / d)}</div>
      </div>
      <div className="capacity-conflict-actions">
        <button
          type="button"
          className="btn-sm capacity-conflict-action-btn"
          onClick={() => onResolve("allowOverflow")}
        >
          {`そのまま割り当て(${fmt2(usedElsewhere / d)}+${fmt2(
            requestedCapacity / d,
          )}=${fmt2(overflowTotal / d)})`}
        </button>
        <button
          type="button"
          className="btn-sm capacity-conflict-action-btn"
          onClick={() => onResolve("fitWithinLimit")}
        >
          超過しない最大値({fmt2(assignableCapacity / d)})を割り当て
        </button>
        <button
          type="button"
          className="btn-sm capacity-conflict-action-btn"
          onClick={() => onResolve("rebalanceOthersProportionally")}
        >
          <span>超過しないように他Epicのキャパシティを削減</span>
          {rebalancePreview.length > 0 && (
            <span className="capacity-conflict-preview-list">
              {rebalancePreview.map((change) => (
                <span
                  key={change.featureName}
                  className="capacity-conflict-preview-item"
                >
                  {change.featureName}: {fmt(change.currentCapacity / d)}→
                  {fmt(change.nextCapacity / d)}
                </span>
              ))}
            </span>
          )}
        </button>
        <button
          type="button"
          className="btn-sm capacity-conflict-action-btn"
          onClick={() => onResolve("rebalanceAllProportionally")}
        >
          <span>比率を保ったままmax capacityに収まるように縮小</span>
          <span className="capacity-conflict-preview-list">
            <span className="capacity-conflict-preview-item">
              今回: {fmt(requestedCapacity / d)}→
              {fmt(rebalanceAllPreview.newCapacity / d)}
            </span>
            {rebalanceAllPreview.othersPreview.map((change) => (
              <span
                key={change.featureName}
                className="capacity-conflict-preview-item"
              >
                {change.featureName}: {fmt(change.currentCapacity / d)}→
                {fmt(change.nextCapacity / d)}
              </span>
            ))}
          </span>
        </button>
        <button
          type="button"
          className="btn-sm capacity-conflict-action-btn"
          onClick={onCancel}
        >
          キャンセル
        </button>
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

const COL_W = 148;

export function MembersView({
  history,
  externalDataVersion,
}: {
  history: HistoryController;
  externalDataVersion: number;
}) {
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const v = localStorage.getItem("roadmap.membersView.viewMode");
      if (v === "quarter" || v === "month") return v;
    } catch {}
    return "quarter";
  });
  const [capacityAggMode, setCapacityAggMode] =
    useState<CapacityAggMode>("total");
  const [quarters, setQuarters] = useState<Quarter[]>([]);
  const [rangeStart, setRangeStart] = useState<QuarterYQ | null>(() => {
    try {
      const v = localStorage.getItem("roadmap.membersView.rangeStart");
      return v ? (JSON.parse(v) as QuarterYQ) : null;
    } catch {}
    return null;
  });
  const [rangeEnd, setRangeEnd] = useState<QuarterYQ | null>(() => {
    try {
      const v = localStorage.getItem("roadmap.membersView.rangeEnd");
      return v ? (JSON.parse(v) as QuarterYQ) : null;
    } catch {}
    return null;
  });
  const rangeInitializedRef = useRef(false);
  const rangeStartRef = useRef(rangeStart);
  rangeStartRef.current = rangeStart;
  const rangeEndRef = useRef(rangeEnd);
  rangeEndRef.current = rangeEnd;
  const [memberRows, setMemberRows] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
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
      localStorage.setItem("roadmap.membersView.viewMode", viewMode);
    } catch {}
  }, [viewMode]);

  useEffect(() => {
    try {
      if (rangeStart !== null)
        localStorage.setItem(
          "roadmap.membersView.rangeStart",
          JSON.stringify(rangeStart),
        );
    } catch {}
  }, [rangeStart]);

  useEffect(() => {
    try {
      if (rangeEnd !== null)
        localStorage.setItem(
          "roadmap.membersView.rangeEnd",
          JSON.stringify(rangeEnd),
        );
    } catch {}
  }, [rangeEnd]);

  // ── Initial load ────────────────────────────────────────────────────────

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [qs, ms] = await Promise.all([
      orpc.quarters.list({}),
      orpc.members.list({}),
    ]);

    const sortedQs = [...qs]
      .map((q) => ({
        ...q,
        months: [...q.months].sort((a, b) => a.month - b.month),
      }))
      .sort((a, b) => a.year - b.year || a.quarter - b.quarter);

    const memberViews = await Promise.all(
      ms.map((m) => orpc.allocations.getMemberView({ memberId: m.id })),
    );

    const rows: MemberRow[] = memberViews.map((mv) => {
      const monthMap = new Map<number, MemberMonthData>();
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
      const memberInfo = ms.find((m) => m.id === mv.member.id);
      return {
        id: mv.member.id,
        name: mv.member.name,
        maxCapacity: memberInfo?.maxCapacity ?? null,
        expanded: false,
        months: monthMap,
      };
    });

    setQuarters(sortedQs);
    if (!rangeInitializedRef.current) {
      rangeInitializedRef.current = true;
      if (rangeStartRef.current === null && rangeEndRef.current === null) {
        const first = sortedQs[0];
        const last = sortedQs[sortedQs.length - 1];
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
    }

    setMemberRows(rows);
    setLoading(false);
  }, []);

  useEffect(() => {
    void history.version;
    void externalDataVersion;
    void loadAll();
  }, [loadAll, history.version, externalDataVersion]);

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
    setMemberRows((rows) =>
      rows.map((r) =>
        r.id === memberId ? { ...r, expanded: !r.expanded } : r,
      ),
    );
  };

  // ── Allocation helpers ────────────────────────────────────────────────────

  const applyAllocationUpdate = useCallback(
    (
      updatedFeatures: Array<{
        epicId: number;
        months: Array<{
          monthId: number;
          totalCapacity: number;
          unassignedCapacity: number;
          memberAllocations: Array<{ memberId: number; capacity: number }>;
        }>;
      }>,
    ) => {
      setMemberRows((rows) =>
        rows.map((member) => {
          let changed = false;
          const newMonths = new Map(member.months);
          for (const updatedFeature of updatedFeatures) {
            for (const updatedMonth of updatedFeature.months) {
              const existing =
                newMonths.get(updatedMonth.monthId) ?? emptyMemberMonthData();
              const memberAlloc = updatedMonth.memberAllocations.find(
                (a) => a.memberId === member.id,
              );
              const newCapacity = memberAlloc?.capacity ?? 0;
              const existingAlloc = existing.featureAllocations.find(
                (fa) => fa.featureId === updatedFeature.epicId,
              );
              if (existingAlloc?.capacity === newCapacity) continue;
              changed = true;
              let newFeatureAllocations: MemberMonthData["featureAllocations"];
              if (newCapacity === 0) {
                newFeatureAllocations = existing.featureAllocations.filter(
                  (fa) => fa.featureId !== updatedFeature.epicId,
                );
              } else if (existingAlloc) {
                newFeatureAllocations = existing.featureAllocations.map((fa) =>
                  fa.featureId === updatedFeature.epicId
                    ? { ...fa, capacity: newCapacity }
                    : fa,
                );
              } else {
                newFeatureAllocations = existing.featureAllocations;
              }
              const newTotalCapacity = newFeatureAllocations.reduce(
                (sum, fa) => sum + fa.capacity,
                0,
              );
              newMonths.set(updatedMonth.monthId, {
                totalCapacity: newTotalCapacity,
                featureAllocations: newFeatureAllocations,
              });
            }
          }
          return changed ? { ...member, months: newMonths } : member;
        }),
      );
    },
    [],
  );

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
          const result = await orpc.allocations.updateMemberAllocation({
            epicId: featureId,
            memberId: member.id,
            capacity,
            periodType: column.type,
            monthId: column.monthId,
            quarterId: column.quarterId,
            capacityConflictResolution: "fitWithinLimit",
          });
          applyAllocationUpdate(result.updatedFeatures);
        });
      } finally {
        setBusy(false);
      }
    },
    [applyAllocationUpdate, history],
  );

  const resolveCapacityConflict = useCallback(
    async (resolution: CapacityConflictResolution) => {
      if (!capacityConflict) return;
      setBusy(true);
      try {
        await history.record("Capacity競合を解決", async () => {
          const result = await orpc.allocations.updateMemberAllocation({
            epicId: capacityConflict.featureId,
            periodType: capacityConflict.periodType,
            monthId: capacityConflict.monthId,
            quarterId: capacityConflict.quarterId,
            memberId: capacityConflict.memberId,
            capacity: capacityConflict.requestedCapacity,
            capacityConflictResolution: resolution,
          });
          applyAllocationUpdate(result.updatedFeatures);
        });
        setCapacityConflict(null);
      } finally {
        setBusy(false);
      }
    },
    [applyAllocationUpdate, capacityConflict, history],
  );

  const resolveMaxCapacityOverflow = useCallback(
    async (resolution: "fitWithinLimit" | "allowOverflow") => {
      if (!maxCapacityOverflow) return;
      setBusy(true);
      try {
        await history.record("Max capacity超過を解決", async () => {
          const result = await orpc.allocations.updateMemberAllocation({
            epicId: maxCapacityOverflow.featureId,
            periodType: maxCapacityOverflow.periodType,
            monthId: maxCapacityOverflow.monthId,
            quarterId: maxCapacityOverflow.quarterId,
            memberId: maxCapacityOverflow.memberId,
            capacity: maxCapacityOverflow.requestedCapacity,
            capacityConflictResolution: resolution,
          });
          applyAllocationUpdate(result.updatedFeatures);
        });
        setMaxCapacityOverflow(null);
      } finally {
        setBusy(false);
      }
    },
    [applyAllocationUpdate, maxCapacityOverflow, history],
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
      setMemberRows((rows) => [
        ...rows,
        {
          id: m.id,
          name: m.name,
          maxCapacity: m.maxCapacity ?? null,
          expanded: false,
          months: new Map(),
        },
      ]);
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
      setMemberRows((rows) =>
        rows.map((r) => (r.id === id ? { ...r, name: m.name } : r)),
      );
      return m.name;
    },
    [history],
  );

  const deleteMember = useCallback(
    async (id: number) => {
      setBusy(true);
      try {
        await history.record("Memberを削除", async () => {
          await orpc.members.delete({ id });
          setMemberRows((rows) => rows.filter((r) => r.id !== id));
        });
      } finally {
        setBusy(false);
      }
    },
    [history],
  );

  const setMaxCapacity = useCallback(
    async (id: number, maxCapacity: number | null) => {
      await history.record("Max capacityを変更", async () => {
        await orpc.members.setMaxCapacity({ id, maxCapacity });
        setMemberRows((rows) =>
          rows.map((r) => (r.id === id ? { ...r, maxCapacity } : r)),
        );
      });
    },
    [history],
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
      await loadAll();
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
  }, [history, importMode, importTsv, loadAll]);

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
      const valid = created.filter(Boolean);
      if (valid.length > 0) {
        setQuarters((qs) =>
          [
            ...qs,
            ...valid.map((q) => ({
              ...q!,
              months: [...q!.months].sort((a, b) => a.month - b.month),
            })),
          ].sort((a, b) => a.year - b.year || a.quarter - b.quarter),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const _addQuarter = async () => {
    setBusy(true);
    try {
      const { year, quarter } = nextQuarterYQ(quarters);
      const q = await history.record("Quarterを追加", async () => {
        return orpc.quarters.create({ year, quarter });
      });
      if (!q) return;
      setQuarters((qs) =>
        [
          ...qs,
          { ...q, months: [...q.months].sort((a, b) => a.month - b.month) },
        ].sort((a, b) => a.year - b.year || a.quarter - b.quarter),
      );
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
                  <tr key={member.id} className="tr-feature">
                    <td className="td-label">
                      <div className="td-label-inner">
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
            if (!importing) setImportModalOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="confirm-dialog import-dialog"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape" && !importing) setImportModalOpen(false);
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
                  onChange={(e) => setImportTsv(e.target.value)}
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
    </div>
  );
}
