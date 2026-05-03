import { useCallback, useEffect, useRef, useState } from "react";
import "./capacity.css";
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
}: {
  name: string;
  onRename: (name: string) => void;
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
    <button
      type="button"
      className="feature-name"
      onClick={startEdit}
      title="クリックで名前を編集"
    >
      {name}
    </button>
  );
}

function MemberLabelCell({
  member,
  onRename,
  onDelete,
}: {
  member: Member;
  onRename: (id: number, name: string) => void;
  onDelete: (id: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(member.name);
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = () => {
    setVal(member.name);
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 20);
  };

  const commit = () => {
    const trimmed = val.trim();
    if (trimmed && trimmed !== member.name) onRename(member.id, trimmed);
    setEditing(false);
  };

  if (editing) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <input
          ref={inputRef}
          className="member-name-input"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      </div>
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
      <button
        type="button"
        className="member-name"
        style={{
          cursor: "text",
          background: "none",
          border: "none",
          padding: 0,
          font: "inherit",
        }}
        onClick={startEdit}
        title="クリックで名前を編集"
      >
        {member.name}
      </button>
      <button
        type="button"
        className="del-member-btn"
        onClick={() => onDelete(member.id)}
        title="メンバーを削除"
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

  const renameMember = useCallback(async (id: number, name: string) => {
    setMembers((ms) => ms.map((m) => (m.id === id ? { ...m, name } : m)));
    await orpc.members.rename({ id, name });
  }, []);

  const deleteMember = useCallback(async (id: number) => {
    setBusy(true);
    try {
      await orpc.members.delete({ id });
      setMembers((ms) => ms.filter((m) => m.id !== id));
      // Remove the member's allocations from local state
      setFeatureRows((rows) =>
        rows.map((r) => {
          const newMap = new Map(r.quarters);
          for (const [qId, qd] of newMap) {
            newMap.set(qId, {
              ...qd,
              memberAllocations: qd.memberAllocations.filter(
                (a) => a.memberId !== id,
              ),
            });
          }
          return { ...r, quarters: newMap };
        }),
      );
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

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="cv-root">
        <header className="cv-header">
          <h1>Roadmap</h1>
          <span className="sep">›</span>
          <span>Feature キャパシティ</span>
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
        <span>Feature キャパシティ</span>
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
                  for (const member of members) {
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
                          <MemberLabelCell
                            member={member}
                            onRename={renameMember}
                            onDelete={deleteMember}
                          />
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
          <span className="hint-text">クリックで数値編集 · + で担当者展開</span>
        </div>
      </div>
    </div>
  );
}
