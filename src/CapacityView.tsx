import { useCallback, useEffect, useRef, useState } from "react";
import "./capacity.css";
import { navigate } from "./navigate";
import { orpc } from "./orpc-client";

// ── Types ──────────────────────────────────────────────────────────────────

type Quarter = { id: number; year: number; quarter: number };
type Member = { id: number; name: string };

type QuarterData = {
  totalCapacity: number;
  unassignedCapacity: number;
  memberAllocations: Array<{ memberId: number; capacity: number }>;
};

type FeatureRow = {
  id: number;
  name: string;
  expanded: boolean;
  quarters: Map<number, QuarterData>;
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

function nextQuarterYQ(quarters: Quarter[]): { year: number; quarter: number } {
  const last = quarters[quarters.length - 1];
  if (!last) return { year: new Date().getFullYear(), quarter: 1 };
  if (last.quarter === 4) return { year: last.year + 1, quarter: 1 };
  return { year: last.year, quarter: last.quarter + 1 };
}

function emptyQuarterData(): QuarterData {
  return { totalCapacity: 0, unassignedCapacity: 0, memberAllocations: [] };
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
      title={`${value} 人月 — クリックで編集`}
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
  isOverflow,
  onCommit,
}: {
  value: number;
  isOverflow: boolean;
  onCommit: (v: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { bg, fg } = heatBg(value, 1);
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
          style={{ color: ovFg, fontSize: 12 }}
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

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setVal(name);
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 20);
  };

  const commit = () => {
    const trimmed = val.trim();
    if (trimmed) onRename(trimmed);
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
        onClick={(e) => e.stopPropagation()}
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

const MAX_VAL = 3;
const COL_W = 148;

export function CapacityView() {
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

  // ── Initial load ────────────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [qs, fs, ms] = await Promise.all([
        orpc.quarters.list({}),
        orpc.features.list({}),
        orpc.members.list({}),
      ]);

      const sortedQs = [...qs].sort(
        (a, b) => a.year - b.year || a.quarter - b.quarter,
      );

      // Load feature view for each feature in parallel
      const featureViews = await Promise.all(
        fs.map((f) => orpc.allocations.getFeatureView({ featureId: f.id })),
      );

      const rows: FeatureRow[] = featureViews.map((fv) => {
        const qMap = new Map<number, QuarterData>();
        for (const qd of fv.quarters) {
          qMap.set(qd.quarter.id, {
            totalCapacity: qd.totalCapacity,
            unassignedCapacity: qd.unassignedCapacity,
            memberAllocations: qd.memberAllocations.map((a) => ({
              memberId: a.member.id,
              capacity: a.capacity,
            })),
          });
        }
        return {
          id: fv.feature.id,
          name: fv.feature.name,
          expanded: false,
          quarters: qMap,
        };
      });

      setQuarters(sortedQs);
      setMembers(ms);
      setFeatureRows(rows);
      setLoading(false);
    })();
  }, []);

  // ── Helpers ──────────────────────────────────────────────────────────────

  const getQData = (row: FeatureRow, quarterId: number): QuarterData =>
    row.quarters.get(quarterId) ?? emptyQuarterData();

  const toggleExpand = (featureId: number) => {
    setFeatureRows((rows) =>
      rows.map((r) =>
        r.id === featureId ? { ...r, expanded: !r.expanded } : r,
      ),
    );
  };

  // ── API actions ───────────────────────────────────────────────────────────

  const updateTotal = useCallback(
    async (featureId: number, quarterId: number, totalCapacity: number) => {
      setBusy(true);
      try {
        const result = await orpc.allocations.updateTotal({
          featureId,
          quarterId,
          totalCapacity,
        });
        setFeatureRows((rows) =>
          rows.map((r) => {
            if (r.id !== featureId) return r;
            const newMap = new Map(r.quarters);
            newMap.set(quarterId, {
              totalCapacity: result.totalCapacity,
              unassignedCapacity: result.unassignedCapacity,
              memberAllocations: result.memberAllocations,
            });
            return { ...r, quarters: newMap };
          }),
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
      quarterId: number,
      memberId: number,
      capacity: number,
    ) => {
      setBusy(true);
      try {
        const result = await orpc.allocations.updateMemberAllocation({
          featureId,
          quarterId,
          memberId,
          capacity,
        });
        setFeatureRows((rows) =>
          rows.map((r) => {
            if (r.id !== featureId) return r;
            const newMap = new Map(r.quarters);
            newMap.set(quarterId, {
              totalCapacity: result.totalCapacity,
              unassignedCapacity: result.unassignedCapacity,
              memberAllocations: result.memberAllocations,
            });
            return { ...r, quarters: newMap };
          }),
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
        { id: f.id, name: f.name, expanded: false, quarters: new Map() },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const renameFeature = useCallback(async (id: number, name: string) => {
    // optimistic update
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

  const addQuarter = async () => {
    setBusy(true);
    try {
      const { year, quarter } = nextQuarterYQ(quarters);
      const q = await orpc.quarters.create({ year, quarter });
      if (!q) return;
      setQuarters((qs) =>
        [...qs, q].sort((a, b) => a.year - b.year || a.quarter - b.quarter),
      );
    } finally {
      setBusy(false);
    }
  };

  const refreshFeatureRow = useCallback(async (featureId: number) => {
    const fv = await orpc.allocations.getFeatureView({ featureId });
    const qMap = new Map<number, QuarterData>();
    for (const qd of fv.quarters) {
      qMap.set(qd.quarter.id, {
        totalCapacity: qd.totalCapacity,
        unassignedCapacity: qd.unassignedCapacity,
        memberAllocations: qd.memberAllocations.map((a) => ({
          memberId: a.member.id,
          capacity: a.capacity,
        })),
      });
    }
    setFeatureRows((rows) =>
      rows.map((r) => (r.id === featureId ? { ...r, quarters: qMap } : r)),
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
                {quarters.map((q) => (
                  <th
                    key={q.id}
                    className="th-quarter"
                    style={{ width: COL_W, minWidth: COL_W }}
                  >
                    {quarterLabel(q)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {featureRows.map((feature, fi) => {
                const hasOverflow = quarters.some(
                  (q) => (getQData(feature, q.id).unassignedCapacity ?? 0) > 0,
                );
                const rows: React.ReactNode[] = [];

                // separator (except first)
                if (fi > 0) {
                  rows.push(
                    <tr key={`sep-${feature.id}`} className="cv-section-sep">
                      <td colSpan={quarters.length + 1} />
                    </tr>,
                  );
                }

                // feature row
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
                    {quarters.map((q) => {
                      const qd = getQData(feature, q.id);
                      return (
                        <td
                          key={q.id}
                          className="td-quarter"
                          style={{ width: COL_W, minWidth: COL_W }}
                        >
                          <HeatmapCell
                            value={qd.totalCapacity}
                            unassigned={qd.unassignedCapacity}
                            maxVal={MAX_VAL}
                            onCommit={(v) => updateTotal(feature.id, q.id, v)}
                            rowHeight={42}
                          />
                        </td>
                      );
                    })}
                  </tr>,
                );

                // member rows (expanded)
                if (feature.expanded) {
                  // Only show members explicitly assigned to this feature
                  const assignedMemberIds = new Set<number>();
                  for (const q of quarters) {
                    for (const a of getQData(feature, q.id).memberAllocations) {
                      assignedMemberIds.add(a.memberId);
                    }
                  }
                  const assignedMembers = members.filter((m) =>
                    assignedMemberIds.has(m.id),
                  );

                  for (const member of assignedMembers) {
                    // Check if member has overflow in any quarter for this feature
                    const isOverflow = quarters.some((q) => {
                      const qd = getQData(feature, q.id);
                      const alloc = qd.memberAllocations.find(
                        (a) => a.memberId === member.id,
                      );
                      return (alloc?.capacity ?? 0) > 1;
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
                        {quarters.map((q) => {
                          const qd = getQData(feature, q.id);
                          const alloc = qd.memberAllocations.find(
                            (a) => a.memberId === member.id,
                          );
                          const value = alloc?.capacity ?? 0;
                          const cellOv = value > 1;
                          return (
                            <td
                              key={q.id}
                              className="td-member-val"
                              style={{ width: COL_W, padding: 0 }}
                            >
                              <HeatmapMemberCell
                                value={value}
                                isOverflow={cellOv}
                                onCommit={(v) =>
                                  updateMemberAllocation(
                                    feature.id,
                                    q.id,
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

                  // assign member row
                  const unassignedMembers = members.filter(
                    (m) => !assignedMemberIds.has(m.id),
                  );
                  rows.push(
                    <tr
                      key={`${feature.id}-assign`}
                      className="tr-assign-member"
                    >
                      <td colSpan={1 + quarters.length} className="td-assign">
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

                  // unassigned row (only if any quarter has overflow)
                  if (hasOverflow) {
                    rows.push(
                      <tr
                        key={`${feature.id}-ua`}
                        className="tr-unassigned-member"
                      >
                        <td className="td-label td-unassigned-label">
                          <span className="unassigned-name">未アサイン</span>
                        </td>
                        {quarters.map((q) => {
                          const uv = getQData(feature, q.id).unassignedCapacity;
                          return (
                            <td
                              key={q.id}
                              className="td-member-val"
                              style={{ width: COL_W, background: "#fff8f8" }}
                            >
                              {uv > 0 ? (
                                <span className="unassigned-val">
                                  +{uv.toFixed(1)}
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
