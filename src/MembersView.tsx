import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
type Month = { id: number; year: number; month: number; quarterId: number };
type Quarter = { id: number; year: number; quarter: number; months: Month[] };
type Member = { id: number; name: string; maxCapacity: number | null };

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
      type: "quarter",
      label: quarterLabel(q),
      monthIds: q.months.map((m) => m.id),
    }));
  }

  return quarters.flatMap((q) =>
    q.months.map((m) => ({
      key: `m-${m.id}`,
      type: "month",
      label: monthLabel(m),
      monthIds: [m.id],
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

// ── Main component ──────────────────────────────────────────────────────────

const COL_W = 148;

export function MembersView({ history }: { history: HistoryController }) {
  const [viewMode, setViewMode] = useState<ViewMode>("quarter");
  const [capacityAggMode, setCapacityAggMode] =
    useState<CapacityAggMode>("total");
  const [quarters, setQuarters] = useState<Quarter[]>([]);
  const [rangeStart, setRangeStart] = useState<QuarterYQ | null>(null);
  const [rangeEnd, setRangeEnd] = useState<QuarterYQ | null>(null);
  const rangeInitializedRef = useRef(false);
  const [memberRows, setMemberRows] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionWarning, setActionWarning] = useState<string | null>(null);

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
            featureAllocations: md.featureAllocations.map((fa) => ({
              featureId: fa.feature.id,
              featureName: fa.feature.name,
              epicName: fa.feature.epic?.name ?? null,
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

    setMemberRows(rows);
    setLoading(false);
  }, []);

  useEffect(() => {
    void history.version;
    void loadAll();
  }, [loadAll, history.version]);

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

  const addQuarter = async () => {
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
              Features
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
            Features
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
                      rows.push(
                        <tr
                          key={`${member.id}-${featureId}`}
                          className="tr-member"
                        >
                          <td className="td-label td-member-label">
                            <span className="member-name">
                              {featureInfo.featureName}
                              {featureInfo.epicName && (
                                <span className="member-feature-epic">
                                  {featureInfo.epicName}
                                </span>
                              )}
                            </span>
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
                            const displayValue = (fa?.capacity ?? 0) / div;
                            const displayLimit = limit / div;
                            const { bg, fg } = heatBg(
                              displayValue,
                              displayLimit,
                            );
                            return (
                              <td
                                key={column.key}
                                className="td-member-val"
                                style={{ width: COL_W, padding: 0 }}
                              >
                                <div
                                  className="hm-member-cell"
                                  style={{
                                    background: cellOv
                                      ? "oklch(72% 0.18 25)"
                                      : bg,
                                    cursor: "default",
                                  }}
                                >
                                  <span
                                    className="hm-member-val"
                                    style={{
                                      color:
                                        displayValue === 0
                                          ? "transparent"
                                          : cellOv
                                            ? "#fff"
                                            : fg,
                                    }}
                                  >
                                    {fmt(displayValue)}
                                  </span>
                                </div>
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
            onClick={addQuarter}
            disabled={busy}
          >
            + Quarter
          </button>

          {(actionWarning || history.warning) && (
            <span className="name-action-warning" role="alert">
              {actionWarning || history.warning}
            </span>
          )}
          <span className="hint-text">+ でFeature展開</span>
        </div>
      </div>
    </div>
  );
}
