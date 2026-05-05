import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./capacity.css";
import { navigate } from "./navigate";
import { orpc } from "./orpc-client";

// ── Types ──────────────────────────────────────────────────────────────────

type ViewMode = "quarter" | "month";
type Month = { id: number; year: number; month: number; quarterId: number };
type Quarter = { id: number; year: number; quarter: number; months: Month[] };
type Member = { id: number; name: string };

type MonthData = {
  totalCapacity: number;
  unassignedCapacity: number;
  memberAllocations: Array<{ memberId: number; capacity: number }>;
};

type FeatureRow = {
  id: number;
  name: string;
  expanded: boolean;
  months: Map<number, MonthData>;
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

const r2 = (v: number) => Math.round(v * 100) / 100;

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

function nextQuarterYQ(quarters: Quarter[]): { year: number; quarter: number } {
  const last = quarters[quarters.length - 1];
  if (!last) return { year: new Date().getFullYear(), quarter: 1 };
  if (last.quarter === 4) return { year: last.year + 1, quarter: 1 };
  return { year: last.year, quarter: last.quarter + 1 };
}

function emptyMonthData(): MonthData {
  return { totalCapacity: 0, unassignedCapacity: 0, memberAllocations: [] };
}

function aggregateMonthData(
  monthMap: Map<number, MonthData>,
  monthIds: number[],
): MonthData {
  const memberTotals = new Map<number, number>();
  let totalCapacity = 0;
  let unassignedCapacity = 0;

  for (const monthId of monthIds) {
    const data = monthMap.get(monthId) ?? emptyMonthData();
    totalCapacity += data.totalCapacity;
    unassignedCapacity += data.unassignedCapacity;
    for (const alloc of data.memberAllocations) {
      memberTotals.set(
        alloc.memberId,
        (memberTotals.get(alloc.memberId) ?? 0) + alloc.capacity,
      );
    }
  }

  return {
    totalCapacity,
    unassignedCapacity,
    memberAllocations: [...memberTotals].map(([memberId, capacity]) => ({
      memberId,
      capacity,
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
      quarterId: q.id,
    }));
  }

  return quarters.flatMap((q) =>
    q.months.map((m) => ({
      key: `m-${m.id}`,
      type: "month",
      label: monthLabel(m),
      monthIds: [m.id],
      monthId: m.id,
    })),
  );
}

function columnMemberLimit(column: PeriodColumn): number {
  return column.type === "quarter" ? column.monthIds.length : 1;
}

function updateMonthResults(
  monthMap: Map<number, MonthData>,
  results: Array<{
    monthId: number;
    totalCapacity: number;
    unassignedCapacity: number;
    memberAllocations: Array<{ memberId: number; capacity: number }>;
  }>,
) {
  const newMap = new Map(monthMap);
  for (const result of results) {
    newMap.set(result.monthId, {
      totalCapacity: result.totalCapacity,
      unassignedCapacity: result.unassignedCapacity,
      memberAllocations: result.memberAllocations,
    });
  }
  return newMap;
}

// ── Sub-components ──────────────────────────────────────────────────────────

function HeatmapCell({
  value,
  unassigned,
  maxVal,
  onCommit,
  rowHeight,
}: {
  value: number;
  unassigned: number;
  maxVal: number;
  onCommit: (v: number) => void;
  rowHeight: number;
}) {
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { bg, fg } = heatBg(value, maxVal);

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
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
      className="hm-cell"
      style={{ background: bg, height: rowHeight }}
      onClick={startEdit}
      title={`${fmt(value)} 人月 · クリックで編集`}
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
          style={{ color: fg }}
        />
      ) : (
        <span
          className="hm-val"
          style={{ color: value === 0 ? "transparent" : fg }}
        >
          {fmt(value)}
        </span>
      )}
      {unassigned > 0 && (
        <span
          style={{
            position: "absolute",
            top: 5,
            right: 5,
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: "var(--cv-red)",
            display: "block",
          }}
        />
      )}
    </button>
  );
}

function HeatmapMemberCell({
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

function FeatureNameCell({
  name,
  onRename,
  onDelete,
}: {
  name: string;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = () => {
    setVal(name);
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 20);
  };

  const commit = () => {
    const trimmed = val.trim();
    if (trimmed && trimmed !== name) onRename(trimmed);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="feature-name-input"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
      />
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
        {name}
      </button>
      <button
        type="button"
        className="del-member-btn"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        title="Featureを削除"
      >
        ×
      </button>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

const FEATURE_MAX_VAL = 3;
const COL_W = 148;

export function CapacityView() {
  const [viewMode, setViewMode] = useState<ViewMode>("quarter");
  const [quarters, setQuarters] = useState<Quarter[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [featureRows, setFeatureRows] = useState<FeatureRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [assigningFeatureId, setAssigningFeatureId] = useState<number | null>(
    null,
  );
  const [removeConfirm, setRemoveConfirm] = useState<{
    featureId: number;
    memberId: number;
    memberName: string;
    featureName: string;
  } | null>(null);

  const columns = useMemo(
    () => columnsForMode(quarters, viewMode),
    [quarters, viewMode],
  );

  // ── Initial load ────────────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [qs, fs, ms] = await Promise.all([
        orpc.quarters.list({}),
        orpc.features.list({}),
        orpc.members.list({}),
      ]);

      const sortedQs = [...qs]
        .map((q) => ({
          ...q,
          months: [...q.months].sort((a, b) => a.month - b.month),
        }))
        .sort((a, b) => a.year - b.year || a.quarter - b.quarter);

      const featureViews = await Promise.all(
        fs.map((f) => orpc.allocations.getFeatureView({ featureId: f.id })),
      );

      const rows: FeatureRow[] = featureViews.map((fv) => {
        const monthMap = new Map<number, MonthData>();
        for (const qd of fv.quarters) {
          for (const md of qd.months) {
            monthMap.set(md.month.id, {
              totalCapacity: md.totalCapacity,
              unassignedCapacity: md.unassignedCapacity,
              memberAllocations: md.memberAllocations.map((a) => ({
                memberId: a.member.id,
                capacity: a.capacity,
              })),
            });
          }
        }
        return {
          id: fv.feature.id,
          name: fv.feature.name,
          expanded: false,
          months: monthMap,
        };
      });

      setQuarters(sortedQs);
      setMembers(ms);
      setFeatureRows(rows);
      setLoading(false);
    })();
  }, []);

  // ── Helpers ──────────────────────────────────────────────────────────────

  const getColumnData = (row: FeatureRow, column: PeriodColumn): MonthData =>
    aggregateMonthData(row.months, column.monthIds);

  const toggleExpand = (featureId: number) => {
    setFeatureRows((rows) =>
      rows.map((r) =>
        r.id === featureId ? { ...r, expanded: !r.expanded } : r,
      ),
    );
  };

  // ── API actions ───────────────────────────────────────────────────────────

  const updateTotal = useCallback(
    async (featureId: number, column: PeriodColumn, totalCapacity: number) => {
      setBusy(true);
      try {
        const result = await orpc.allocations.updateTotal({
          featureId,
          totalCapacity,
          periodType: column.type,
          monthId: column.monthId,
          quarterId: column.quarterId,
        });
        setFeatureRows((rows) =>
          rows.map((r) =>
            r.id === featureId
              ? { ...r, months: updateMonthResults(r.months, result.months) }
              : r,
          ),
        );
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const updateMemberAllocation = useCallback(
    async (
      featureId: number,
      column: PeriodColumn,
      memberId: number,
      capacity: number,
    ) => {
      setBusy(true);
      try {
        const result = await orpc.allocations.updateMemberAllocation({
          featureId,
          memberId,
          capacity,
          periodType: column.type,
          monthId: column.monthId,
          quarterId: column.quarterId,
        });
        setFeatureRows((rows) =>
          rows.map((r) =>
            r.id === featureId
              ? { ...r, months: updateMonthResults(r.months, result.months) }
              : r,
          ),
        );
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const addFeature = async () => {
    setBusy(true);
    try {
      const f = await orpc.features.create({
        name: `Feature ${featureRows.length + 1}`,
      });
      if (!f) return;
      setFeatureRows((rows) => [
        ...rows,
        { id: f.id, name: f.name, expanded: false, months: new Map() },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const renameFeature = useCallback(async (id: number, name: string) => {
    setFeatureRows((rows) =>
      rows.map((r) => (r.id === id ? { ...r, name } : r)),
    );
    await orpc.features.rename({ id, name });
  }, []);

  const deleteFeature = useCallback(async (id: number) => {
    setBusy(true);
    try {
      await orpc.features.delete({ id });
      setFeatureRows((rows) => rows.filter((r) => r.id !== id));
    } finally {
      setBusy(false);
    }
  }, []);

  const addMember = async () => {
    setBusy(true);
    try {
      const m = await orpc.members.create({
        name: `Member ${members.length + 1}`,
      });
      if (!m) return;
      setMembers((ms) => [...ms, m]);
    } finally {
      setBusy(false);
    }
  };

  const addQuarter = async () => {
    setBusy(true);
    try {
      const { year, quarter } = nextQuarterYQ(quarters);
      const q = await orpc.quarters.create({ year, quarter });
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

  const refreshFeatureRow = useCallback(async (featureId: number) => {
    const fv = await orpc.allocations.getFeatureView({ featureId });
    const monthMap = new Map<number, MonthData>();
    for (const qd of fv.quarters) {
      for (const md of qd.months) {
        monthMap.set(md.month.id, {
          totalCapacity: md.totalCapacity,
          unassignedCapacity: md.unassignedCapacity,
          memberAllocations: md.memberAllocations.map((a) => ({
            memberId: a.member.id,
            capacity: a.capacity,
          })),
        });
      }
    }
    setFeatureRows((rows) =>
      rows.map((r) => (r.id === featureId ? { ...r, months: monthMap } : r)),
    );
  }, []);

  const assignMemberToFeature = useCallback(
    async (featureId: number, memberId: number) => {
      setBusy(true);
      try {
        await orpc.allocations.assignMember({ featureId, memberId });
        await refreshFeatureRow(featureId);
      } finally {
        setBusy(false);
      }
    },
    [refreshFeatureRow],
  );

  const removeMemberFromFeature = useCallback(
    async (featureId: number, memberId: number) => {
      setBusy(true);
      try {
        await orpc.allocations.removeMemberFromFeature({ featureId, memberId });
        await refreshFeatureRow(featureId);
      } finally {
        setBusy(false);
      }
    },
    [refreshFeatureRow],
  );

  const copyAllocationCSV = useCallback(async () => {
    const csv = await orpc.export.allocationCSV({});
    await navigator.clipboard.writeText(csv);
  }, []);

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
              className="cv-nav-link active"
              onClick={() => navigate("/features")}
            >
              Features
            </button>
            <button
              type="button"
              className="cv-nav-link"
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
            className="cv-nav-link active"
            onClick={() => navigate("/features")}
          >
            Features
          </button>
          <button
            type="button"
            className="cv-nav-link"
            onClick={() => navigate("/members")}
          >
            Members
          </button>
        </nav>
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
                <th className="th-label">Feature</th>
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
              {featureRows.map((feature, fi) => {
                const hasOverflow = columns.some(
                  (column) =>
                    (getColumnData(feature, column).unassignedCapacity ?? 0) >
                    0,
                );
                const rows: React.ReactNode[] = [];

                if (fi > 0) {
                  rows.push(
                    <tr key={`sep-${feature.id}`} className="cv-section-sep">
                      <td colSpan={columns.length + 1} />
                    </tr>,
                  );
                }

                rows.push(
                  <tr key={feature.id} className="tr-feature">
                    <td className="td-label">
                      <div className="td-label-inner">
                        <button
                          type="button"
                          className="toggle-btn"
                          onClick={() => toggleExpand(feature.id)}
                          title={feature.expanded ? "折りたたむ" : "詳細を展開"}
                        >
                          {feature.expanded ? "−" : "+"}
                        </button>
                        <FeatureNameCell
                          name={feature.name}
                          onRename={(name) => renameFeature(feature.id, name)}
                          onDelete={() => deleteFeature(feature.id)}
                        />
                        {hasOverflow && (
                          <span
                            className="overflow-dot"
                            title="未アサインあり"
                          />
                        )}
                      </div>
                    </td>
                    {columns.map((column) => {
                      const data = getColumnData(feature, column);
                      return (
                        <td
                          key={column.key}
                          className="td-quarter"
                          style={{ width: COL_W, minWidth: COL_W }}
                        >
                          <HeatmapCell
                            value={data.totalCapacity}
                            unassigned={data.unassignedCapacity}
                            maxVal={FEATURE_MAX_VAL}
                            onCommit={(v) => updateTotal(feature.id, column, v)}
                            rowHeight={42}
                          />
                        </td>
                      );
                    })}
                  </tr>,
                );

                if (feature.expanded) {
                  const assignedMemberIds = new Set<number>();
                  for (const monthData of feature.months.values()) {
                    for (const a of monthData.memberAllocations) {
                      assignedMemberIds.add(a.memberId);
                    }
                  }
                  const assignedMembers = members.filter((m) =>
                    assignedMemberIds.has(m.id),
                  );

                  for (const member of assignedMembers) {
                    const isOverflow = columns.some((column) => {
                      const data = getColumnData(feature, column);
                      const alloc = data.memberAllocations.find(
                        (a) => a.memberId === member.id,
                      );
                      return (alloc?.capacity ?? 0) > columnMemberLimit(column);
                    });

                    rows.push(
                      <tr
                        key={`${feature.id}-${member.id}`}
                        className={`tr-member${isOverflow ? " is-overflow" : ""}`}
                      >
                        <td className="td-label td-member-label">
                          <div className="member-label-row">
                            <span className="member-name">{member.name}</span>
                            <button
                              type="button"
                              className="del-member-btn"
                              onClick={() =>
                                setRemoveConfirm({
                                  featureId: feature.id,
                                  memberId: member.id,
                                  memberName: member.name,
                                  featureName: feature.name,
                                })
                              }
                              title="このFeatureから削除"
                            >
                              ×
                            </button>
                          </div>
                        </td>
                        {columns.map((column) => {
                          const data = getColumnData(feature, column);
                          const alloc = data.memberAllocations.find(
                            (a) => a.memberId === member.id,
                          );
                          const value = alloc?.capacity ?? 0;
                          const limit = columnMemberLimit(column);
                          return (
                            <td
                              key={column.key}
                              className="td-member-val"
                              style={{ width: COL_W, padding: 0 }}
                            >
                              <HeatmapMemberCell
                                value={value}
                                maxVal={limit}
                                isOverflow={value > limit}
                                onCommit={(v) =>
                                  updateMemberAllocation(
                                    feature.id,
                                    column,
                                    member.id,
                                    v,
                                  )
                                }
                              />
                            </td>
                          );
                        })}
                      </tr>,
                    );
                  }

                  const unassignedMembers = members.filter(
                    (m) => !assignedMemberIds.has(m.id),
                  );
                  rows.push(
                    <tr
                      key={`${feature.id}-assign`}
                      className="tr-assign-member"
                    >
                      <td colSpan={1 + columns.length} className="td-assign">
                        {assigningFeatureId === feature.id ? (
                          <select
                            className="assign-select"
                            // biome-ignore lint/a11y/noAutofocus: intentional focus for inline dropdown
                            autoFocus
                            defaultValue=""
                            onChange={(e) => {
                              const id = Number(e.target.value);
                              if (id) assignMemberToFeature(feature.id, id);
                              setAssigningFeatureId(null);
                            }}
                            onBlur={() => setAssigningFeatureId(null)}
                          >
                            <option value="" disabled>
                              -- メンバーを選択 --
                            </option>
                            {unassignedMembers.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <button
                            type="button"
                            className="btn-assign"
                            disabled={busy || unassignedMembers.length === 0}
                            onClick={() => setAssigningFeatureId(feature.id)}
                          >
                            + メンバーを割り当て
                          </button>
                        )}
                      </td>
                    </tr>,
                  );

                  if (hasOverflow) {
                    rows.push(
                      <tr
                        key={`${feature.id}-ua`}
                        className="tr-unassigned-member"
                      >
                        <td className="td-label td-unassigned-label">
                          <span className="unassigned-name">未アサイン</span>
                        </td>
                        {columns.map((column) => {
                          const uv = getColumnData(
                            feature,
                            column,
                          ).unassignedCapacity;
                          return (
                            <td
                              key={column.key}
                              className="td-member-val"
                              style={{ width: COL_W, background: "#fff8f8" }}
                            >
                              {uv > 0 ? (
                                <span className="unassigned-val">
                                  +{fmt(uv)}
                                </span>
                              ) : (
                                <span className="mval-dash">—</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>,
                    );
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
            onClick={addFeature}
            disabled={busy}
          >
            + Feature
          </button>
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
          <button
            type="button"
            className="btn-sm"
            onClick={copyAllocationCSV}
            disabled={busy}
            title="機能・担当者・キャパシティ・月次形式のCSVをコピー"
          >
            CSVをコピー
          </button>
          <span className="hint-text">クリックで数値編集 · + で担当者展開</span>
        </div>
      </div>

      {removeConfirm && (
        <div className="confirm-overlay">
          <div
            role="dialog"
            aria-modal="true"
            className="confirm-dialog"
            onKeyDown={(e) => {
              if (e.key === "Escape") setRemoveConfirm(null);
            }}
          >
            <p className="confirm-msg">
              「{removeConfirm.memberName}」を「{removeConfirm.featureName}
              」から削除しますか？
            </p>
            <div className="confirm-btns">
              <button
                type="button"
                className="btn-sm"
                onClick={() => setRemoveConfirm(null)}
              >
                キャンセル
              </button>
              <button
                type="button"
                className="btn-sm btn-danger"
                onClick={() => {
                  removeMemberFromFeature(
                    removeConfirm.featureId,
                    removeConfirm.memberId,
                  );
                  setRemoveConfirm(null);
                }}
              >
                削除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
