import { useCallback, useEffect, useRef, useState } from "react";
import "./capacity.css";
import { navigate } from "./navigate";
import { orpc } from "./orpc-client";

// ── Types ──────────────────────────────────────────────────────────────────

type Quarter = { id: number; year: number; quarter: number };
type Member = { id: number; name: string };

type MemberQuarterData = {
  totalCapacity: number;
  featureAllocations: Array<{ featureId: number; featureName: string; capacity: number }>;
};

type MemberRow = {
  id: number;
  name: string;
  expanded: boolean;
  quarters: Map<number, MemberQuarterData>;
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

function nextQuarterYQ(quarters: Quarter[]): { year: number; quarter: number } {
  const last = quarters[quarters.length - 1];
  if (!last) return { year: new Date().getFullYear(), quarter: 1 };
  if (last.quarter === 4) return { year: last.year + 1, quarter: 1 };
  return { year: last.year, quarter: last.quarter + 1 };
}

function emptyMemberQuarterData(): MemberQuarterData {
  return { totalCapacity: 0, featureAllocations: [] };
}

// ── Sub-components ──────────────────────────────────────────────────────────

function ReadonlyHeatmapCell({
  value,
  maxVal,
  rowHeight,
}: {
  value: number;
  maxVal: number;
  rowHeight: number;
}) {
  const { bg, fg } = heatBg(value, maxVal);
  return (
    <div
      className="hm-cell"
      style={{ background: bg, height: rowHeight, cursor: "default" }}
    >
      <span
        className="hm-val"
        style={{ color: value === 0 ? "transparent" : fg }}
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
          className="feature-name-input"
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

// ── Main component ──────────────────────────────────────────────────────────

const COL_W = 148;

export function MembersView() {
  const [quarters, setQuarters] = useState<Quarter[]>([]);
  const [memberRows, setMemberRows] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // ── Initial load ────────────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [qs, ms] = await Promise.all([
        orpc.quarters.list({}),
        orpc.members.list({}),
      ]);

      const sortedQs = [...qs].sort(
        (a, b) => a.year - b.year || a.quarter - b.quarter,
      );

      const memberViews = await Promise.all(
        ms.map((m) => orpc.allocations.getMemberView({ memberId: m.id })),
      );

      const rows: MemberRow[] = memberViews.map((mv) => {
        const qMap = new Map<number, MemberQuarterData>();
        for (const qd of mv.quarters) {
          qMap.set(qd.quarter.id, {
            totalCapacity: qd.totalCapacity,
            featureAllocations: qd.featureAllocations.map((fa) => ({
              featureId: fa.feature.id,
              featureName: fa.feature.name,
              capacity: fa.capacity,
            })),
          });
        }
        return {
          id: mv.member.id,
          name: mv.member.name,
          expanded: false,
          quarters: qMap,
        };
      });

      setQuarters(sortedQs);
      setMemberRows(rows);
      setLoading(false);
    })();
  }, []);

  // ── Helpers ──────────────────────────────────────────────────────────────

  const getQData = (row: MemberRow, quarterId: number): MemberQuarterData =>
    row.quarters.get(quarterId) ?? emptyMemberQuarterData();

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
    try {
      const m = await orpc.members.create({
        name: `Member ${memberRows.length + 1}`,
      });
      if (!m) return;
      setMemberRows((rows) => [
        ...rows,
        { id: m.id, name: m.name, expanded: false, quarters: new Map() },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const renameMember = useCallback(async (id: number, name: string) => {
    setMemberRows((rows) =>
      rows.map((r) => (r.id === id ? { ...r, name } : r)),
    );
    await orpc.members.rename({ id, name });
  }, []);

  const deleteMember = useCallback(async (id: number) => {
    setBusy(true);
    try {
      await orpc.members.delete({ id });
      setMemberRows((rows) => rows.filter((r) => r.id !== id));
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
          <nav className="cv-nav">
            <button type="button" className="cv-nav-link" onClick={() => navigate("/features")}>Features</button>
            <button type="button" className="cv-nav-link active" onClick={() => navigate("/members")}>Members</button>
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
          <button type="button" className="cv-nav-link" onClick={() => navigate("/features")}>Features</button>
          <button type="button" className="cv-nav-link active" onClick={() => navigate("/members")}>Members</button>
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
                <th className="th-label">Member</th>
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
              {memberRows.map((member, mi) => {
                const rows: React.ReactNode[] = [];

                if (mi > 0) {
                  rows.push(
                    <tr key={`sep-${member.id}`} className="cv-section-sep">
                      <td colSpan={quarters.length + 1} />
                    </tr>,
                  );
                }

                // member row
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
                    {quarters.map((q) => {
                      const qd = getQData(member, q.id);
                      return (
                        <td
                          key={q.id}
                          className="td-quarter"
                          style={{ width: COL_W, minWidth: COL_W }}
                        >
                          <ReadonlyHeatmapCell
                            value={qd.totalCapacity}
                            maxVal={1}
                            rowHeight={42}
                          />
                        </td>
                      );
                    })}
                  </tr>,
                );

                // feature sub-rows (expanded)
                if (member.expanded) {
                  // Collect all features that appear in at least one quarter
                  const featureMap = new Map<number, string>();
                  for (const qd of member.quarters.values()) {
                    for (const fa of qd.featureAllocations) {
                      featureMap.set(fa.featureId, fa.featureName);
                    }
                  }

                  if (featureMap.size === 0) {
                    rows.push(
                      <tr key={`${member.id}-empty`} className="tr-member">
                        <td
                          className="td-label td-member-label"
                          colSpan={quarters.length + 1}
                          style={{ color: "var(--cv-text-3)", fontStyle: "italic", fontSize: 12 }}
                        >
                          アサインなし
                        </td>
                      </tr>,
                    );
                  } else {
                    for (const [featureId, featureName] of featureMap) {
                      rows.push(
                        <tr key={`${member.id}-${featureId}`} className="tr-member">
                          <td className="td-label td-member-label">
                            <span className="member-name">{featureName}</span>
                          </td>
                          {quarters.map((q) => {
                            const qd = getQData(member, q.id);
                            const fa = qd.featureAllocations.find(
                              (a) => a.featureId === featureId,
                            );
                            const value = fa?.capacity ?? 0;
                            return (
                              <td
                                key={q.id}
                                className="td-member-val"
                                style={{ width: COL_W, padding: 0 }}
                              >
                                <div
                                  className="hm-member-cell"
                                  style={{
                                    background: heatBg(value, 1).bg,
                                    cursor: "default",
                                  }}
                                >
                                  <span
                                    className="hm-member-val"
                                    style={{
                                      color: value === 0 ? "transparent" : heatBg(value, 1).fg,
                                    }}
                                  >
                                    {fmt(value)}
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
          <span className="hint-text">+ でFeature展開</span>
        </div>
      </div>
    </div>
  );
}
