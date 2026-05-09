import {
  ArrowDown,
  ArrowUp,
  ExternalLink,
  GripVertical,
  Info,
  Link as LinkIcon,
  Plus,
  Trash2,
} from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "./capacity.css";
import { parseCapacityTSV } from "./capacity-clipboard";
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
type CellType = "epic" | "member";
type EpicLink = {
  id?: number;
  title: string;
  url: string;
  position?: number;
  clientKey?: string;
};

type MonthData = {
  totalCapacity: number;
  unassignedCapacity: number;
  memberAllocations: Array<{ memberId: number; capacity: number }>;
};

type EpicRow = {
  id: number;
  name: string;
  description: string | null;
  initiativeId: number;
  position: number;
  links: EpicLink[];
  expanded: boolean;
  months: Map<number, MonthData>;
};

type InitiativeRow = {
  id: number;
  name: string;
  description: string | null;
  position: number;
  isDefault: boolean;
  links: EpicLink[];
  collapsed: boolean;
};

type PeriodColumn = {
  key: string;
  type: ViewMode;
  label: string;
  monthIds: number[];
  monthId?: number;
  quarterId?: number;
};

type CapacityConflictResolution =
  | "fitWithinLimit"
  | "allowOverflow"
  | "rebalanceOthersProportionally"
  | "rebalanceAllProportionally";

type EpicMonthUpdate = {
  epicId: number;
  months: Array<{
    monthId: number;
    totalCapacity: number;
    unassignedCapacity: number;
    memberAllocations: Array<{ memberId: number; capacity: number }>;
  }>;
};

type PendingCapacityConflict = {
  epicId: number;
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
  epicId: number;
  periodType: ViewMode;
  monthId?: number;
  quarterId?: number;
  memberId: number;
  memberName: string;
  requestedCapacity: number;
  limit: number;
  usedElsewhere: number;
};

type RebalancePreview = {
  epicName: string;
  currentCapacity: number;
  nextCapacity: number;
};

type SelectableRow =
  | { type: "epic"; epicId: number }
  | { type: "member"; epicId: number; memberId: number };

type SelectionRect = {
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
  type: CellType;
};

type CopiedSelection = {
  viewMode: ViewMode;
  sourceSel: SelectionRect;
};

type GridPasteTarget = {
  row: number;
  col: number;
};

type PasteOp =
  | { kind: "epic"; epicId: number; column: PeriodColumn; value: number }
  | {
      kind: "member";
      epicId: number;
      memberId: number;
      column: PeriodColumn;
      value: number;
    };

type PasteConflictItem = {
  rowLabel: string;
  colLabel: string;
  sourceValue: number;
  cappedValue: number;
};

type PasteConflictState = {
  conflicts: PasteConflictItem[];
  opsForCapped: PasteOp[];
  opsForOverflow: PasteOp[];
};

type DragItem =
  | { type: "initiative"; initiativeId: number }
  | { type: "epic"; epicId: number; initiativeId: number };

// ── Helpers ─────────────────────────────────────────────────────────────────

const r2 = (v: number) => Math.round(v * 100) / 100;

function fmt(v: number): string {
  if (v === 0) return "0";
  return v % 1 === 0 ? v.toFixed(0) : v.toFixed(2).replace(/\.?0+$/, "");
}

function fmt2(v: number): string {
  return v.toFixed(2);
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

function emptyMonthData(): MonthData {
  return { totalCapacity: 0, unassignedCapacity: 0, memberAllocations: [] };
}

function isOpenableEpicUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
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

function columnMemberLimit(column: PeriodColumn, maxCapacity = 1): number {
  return column.type === "quarter"
    ? column.monthIds.length * maxCapacity
    : maxCapacity;
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

function isEditablePasteTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return !!target.closest("input, textarea, [contenteditable='true']");
}

function isGridValuePasteTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return !!target.closest(".hm-input");
}

// ── Sub-components ──────────────────────────────────────────────────────────

function HeatmapCell({
  value,
  unassigned,
  maxVal,
  onCommit,
  rowHeight,
  isSelected,
  isCopied,
  onCellMouseDown,
  onCellMouseEnter,
  editCancelToken,
}: {
  value: number;
  unassigned: number;
  maxVal: number;
  onCommit: (v: number) => void;
  rowHeight: number;
  isSelected?: boolean;
  isCopied?: boolean;
  onCellMouseDown?: () => void;
  onCellMouseEnter?: () => void;
  editCancelToken?: number;
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

  useEffect(() => {
    if (editCancelToken === undefined) return;
    setEditing(false);
  }, [editCancelToken]);

  const cls = ["hm-cell", isSelected && "is-selected", isCopied && "is-copied"]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className={cls}
      style={{ background: bg, height: rowHeight }}
      onClick={startEdit}
      onMouseDown={onCellMouseDown}
      onMouseEnter={onCellMouseEnter}
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
  isSelected,
  isCopied,
  onCellMouseDown,
  onCellMouseEnter,
  editCancelToken,
}: {
  value: number;
  maxVal: number;
  isOverflow: boolean;
  onCommit: (v: number) => void;
  isSelected?: boolean;
  isCopied?: boolean;
  onCellMouseDown?: () => void;
  onCellMouseEnter?: () => void;
  editCancelToken?: number;
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

  useEffect(() => {
    if (editCancelToken === undefined) return;
    setEditing(false);
  }, [editCancelToken]);

  const cls = [
    "hm-member-cell",
    isSelected && "is-selected",
    isCopied && "is-copied",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className={cls}
      style={{ background: ovBg }}
      onClick={startEdit}
      onMouseDown={onCellMouseDown}
      onMouseEnter={onCellMouseEnter}
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

function EpicNameCell({
  name,
  hasDescription,
  links,
  onRename,
  onDelete,
  onEditDetails,
}: {
  name: string;
  hasDescription: boolean;
  links: Array<{ url: string }>;
  onRename: (name: string) => Promise<string | undefined>;
  onDelete: () => void;
  onEditDetails: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const committingRef = useRef(false);

  useEffect(() => {
    if (!editing) setVal(name);
  }, [editing, name]);

  const startEdit = () => {
    setVal(name);
    setError(null);
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 20);
  };

  const cancelEdit = () => {
    setVal(name);
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
    if (trimmed === name) {
      cancelEdit();
      return;
    }

    committingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const savedName = await onRename(trimmed);
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
          className="epic-name-input"
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
          onClick={(e) => e.stopPropagation()}
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
    <div className="epic-name-row">
      <button
        type="button"
        className="epic-name"
        onClick={startEdit}
        title="クリックで名前を編集"
      >
        {name}
      </button>
      <button
        type="button"
        className={`epic-meta-btn${hasDescription ? " active" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          onEditDetails();
        }}
        title={hasDescription ? "説明あり" : "Epic詳細を編集"}
        aria-label="Epic詳細を編集"
      >
        <Info size={13} />
      </button>
      {links.length > 0 && (
        <button
          type="button"
          className="epic-meta-btn active"
          onClick={(e) => {
            e.stopPropagation();
            for (const link of links) {
              if (link.url)
                window.open(link.url, "_blank", "noopener,noreferrer");
            }
          }}
          title={`${links.length}件のリンク`}
          aria-label={`${links.length}件のリンクを別タブで開く`}
        >
          <LinkIcon size={13} />
        </button>
      )}
      <button
        type="button"
        className="del-member-btn"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        title="Epicを削除"
      >
        ×
      </button>
    </div>
  );
}

function EpicDetailsDialog({
  epic,
  initiatives,
  onSave,
  onClose,
}: {
  epic: EpicRow;
  initiatives: InitiativeRow[];
  onSave: (input: {
    name: string;
    initiativeId: number;
    description: string | null;
    links: Array<{ title: string; url: string }>;
  }) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(epic.name);
  const [initiativeId, setInitiativeId] = useState(epic.initiativeId);
  const [description, setDescription] = useState(epic.description ?? "");
  const [links, setLinks] = useState<EpicLink[]>(
    epic.links.length > 0
      ? epic.links.map((link) => ({
          ...link,
          clientKey: `saved-${link.id ?? crypto.randomUUID()}`,
        }))
      : [{ title: "", url: "", clientKey: crypto.randomUUID() }],
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const updateLink = (index: number, key: "title" | "url", value: string) => {
    setLinks((current) =>
      current.map((link, i) =>
        i === index ? { ...link, [key]: value } : link,
      ),
    );
    setError(null);
  };

  const moveLink = (index: number, offset: -1 | 1) => {
    setLinks((current) => {
      const next = [...current];
      const target = index + offset;
      if (target < 0 || target >= next.length) return current;
      const [item] = next.splice(index, 1);
      if (!item) return current;
      next.splice(target, 0, item);
      return next;
    });
  };

  const removeLink = (index: number) => {
    setLinks((current) => current.filter((_, i) => i !== index));
  };

  const save = async () => {
    const trimmedName = trimSqliteSpaces(name);
    if (trimmedName.length === 0) {
      setError(NAME_ERROR_MESSAGES.blank);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: trimmedName,
        initiativeId,
        description: description.trim().length > 0 ? description : null,
        links: links.map((link) => ({ title: link.title, url: link.url })),
      });
      onClose();
    } catch (error) {
      const message =
        getNameErrorMessage(error) ??
        (error instanceof Error ? error.message : null) ??
        "保存できませんでした。";
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop closes on click; keyboard handled by dialog via Escape
    // biome-ignore lint/a11y/useKeyWithClickEvents: modal backdrop closes on click; keyboard handled by dialog via Escape
    <div
      className="confirm-overlay"
      onClick={() => {
        if (!saving) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="confirm-dialog epic-details-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape" && !saving) onClose();
        }}
      >
        <div className="epic-details-header">
          <p className="confirm-msg">Epic詳細</p>
        </div>

        <label className="epic-details-label">
          <span>名前</span>
          <input
            className="epic-details-input"
            value={name}
            disabled={saving}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
        </label>

        <label className="epic-details-label">
          <span>Initiative</span>
          <select
            className="epic-details-input"
            value={initiativeId}
            disabled={saving}
            onChange={(e) => setInitiativeId(Number(e.target.value))}
          >
            {initiatives.map((initiative) => (
              <option key={initiative.id} value={initiative.id}>
                {initiative.name}
              </option>
            ))}
          </select>
        </label>

        <label className="epic-details-label">
          <span>説明</span>
          <textarea
            className="epic-details-textarea"
            value={description}
            disabled={saving}
            maxLength={2000}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <div className="epic-details-links">
          {links.map((link, index) => (
            <div className="epic-details-link-row" key={link.clientKey}>
              <input
                className="epic-details-input"
                value={link.title}
                disabled={saving}
                maxLength={100}
                placeholder="リンク名"
                onChange={(e) => updateLink(index, "title", e.target.value)}
              />
              <input
                className="epic-details-input"
                value={link.url}
                disabled={saving}
                maxLength={2048}
                placeholder="https://example.com"
                onChange={(e) => updateLink(index, "url", e.target.value)}
              />
              {isOpenableEpicUrl(link.url.trim()) && (
                <a
                  className="epic-details-icon-btn"
                  href={link.url.trim()}
                  target="_blank"
                  rel="noreferrer"
                  title="リンクを開く"
                  aria-label="リンクを開く"
                >
                  <ExternalLink size={14} />
                </a>
              )}
              <button
                type="button"
                className="epic-details-icon-btn"
                onClick={() => moveLink(index, -1)}
                disabled={saving || index === 0}
                title="上へ"
                aria-label="上へ"
              >
                <ArrowUp size={14} />
              </button>
              <button
                type="button"
                className="epic-details-icon-btn"
                onClick={() => moveLink(index, 1)}
                disabled={saving || index === links.length - 1}
                title="下へ"
                aria-label="下へ"
              >
                <ArrowDown size={14} />
              </button>
              <button
                type="button"
                className="epic-details-icon-btn danger"
                onClick={() => removeLink(index)}
                disabled={saving}
                title="削除"
                aria-label="削除"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          className="epic-details-add-link-btn"
          onClick={() =>
            setLinks((current) => [
              ...current,
              { title: "", url: "", clientKey: crypto.randomUUID() },
            ])
          }
          disabled={saving || links.length >= 20}
          title="リンクを追加"
          aria-label="リンクを追加"
        >
          <Plus size={14} />
          リンクを追加
        </button>

        {error && (
          <span className="name-warning epic-details-error" role="alert">
            {error}
          </span>
        )}

        <div className="confirm-btns">
          <button
            type="button"
            className="btn-sm"
            onClick={onClose}
            disabled={saving}
          >
            キャンセル
          </button>
          <button
            type="button"
            className="btn-sm"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

function InitiativeDetailsDialog({
  initiative,
  onSave,
  onClose,
}: {
  initiative: InitiativeRow;
  onSave: (input: {
    name: string;
    description: string | null;
    links: Array<{ title: string; url: string }>;
  }) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initiative.name);
  const [description, setDescription] = useState(initiative.description ?? "");
  const [links, setLinks] = useState<EpicLink[]>(
    initiative.links.length > 0
      ? initiative.links.map((link) => ({
          ...link,
          clientKey: `saved-${link.id ?? crypto.randomUUID()}`,
        }))
      : [{ title: "", url: "", clientKey: crypto.randomUUID() }],
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const trimmedName = trimSqliteSpaces(name);
    if (trimmedName.length === 0) {
      setError(NAME_ERROR_MESSAGES.blank);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: trimmedName,
        description: description.trim().length > 0 ? description : null,
        links: links.map((link) => ({ title: link.title, url: link.url })),
      });
      onClose();
    } catch (error) {
      setError(
        getNameErrorMessage(error) ??
          (error instanceof Error ? error.message : null) ??
          "保存できませんでした。",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop closes on click; keyboard handled by dialog via Escape
    // biome-ignore lint/a11y/useKeyWithClickEvents: modal backdrop closes on click; keyboard handled by dialog via Escape
    <div
      className="confirm-overlay"
      onClick={() => {
        if (!saving) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="confirm-dialog epic-details-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="epic-details-header">
          <p className="confirm-msg">Initiative詳細</p>
          <button
            type="button"
            className="epic-details-icon-btn"
            onClick={() =>
              setLinks((current) => [
                ...current,
                { title: "", url: "", clientKey: crypto.randomUUID() },
              ])
            }
            disabled={saving || links.length >= 20}
            title="リンクを追加"
            aria-label="リンクを追加"
          >
            <Plus size={14} />
          </button>
        </div>
        <label className="epic-details-label">
          <span>名前</span>
          <input
            className="epic-details-input"
            value={name}
            disabled={saving}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
        </label>
        <label className="epic-details-label">
          <span>説明</span>
          <textarea
            className="epic-details-textarea"
            value={description}
            disabled={saving}
            maxLength={2000}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <div className="epic-details-links">
          {links.map((link, index) => (
            <div className="epic-details-link-row" key={link.clientKey}>
              <input
                className="epic-details-input"
                value={link.title}
                disabled={saving}
                maxLength={100}
                placeholder="リンク名"
                onChange={(e) =>
                  setLinks((current) =>
                    current.map((item, i) =>
                      i === index ? { ...item, title: e.target.value } : item,
                    ),
                  )
                }
              />
              <input
                className="epic-details-input"
                value={link.url}
                disabled={saving}
                maxLength={2048}
                placeholder="https://example.com"
                onChange={(e) =>
                  setLinks((current) =>
                    current.map((item, i) =>
                      i === index ? { ...item, url: e.target.value } : item,
                    ),
                  )
                }
              />
              <button
                type="button"
                className="epic-details-icon-btn danger"
                onClick={() =>
                  setLinks((current) => current.filter((_, i) => i !== index))
                }
                disabled={saving}
                title="削除"
                aria-label="削除"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
        {error && (
          <span className="name-warning epic-details-error" role="alert">
            {error}
          </span>
        )}
        <div className="confirm-btns">
          <button
            type="button"
            className="btn-sm"
            onClick={onClose}
            disabled={saving}
          >
            キャンセル
          </button>
          <button
            type="button"
            className="btn-sm"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
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
          <span>超過しないように他機能のキャパシティを削減</span>
          {rebalancePreview.length > 0 && (
            <span className="capacity-conflict-preview-list">
              {rebalancePreview.map((change) => (
                <span
                  key={change.epicName}
                  className="capacity-conflict-preview-item"
                >
                  {change.epicName}: {fmt(change.currentCapacity / d)}→
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
                key={change.epicName}
                className="capacity-conflict-preview-item"
              >
                {change.epicName}: {fmt(change.currentCapacity / d)}→
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

function PasteConflictDialog({
  conflicts,
  opsForCapped,
  opsForOverflow,
  onExecute,
  onCancel,
}: {
  conflicts: PasteConflictItem[];
  opsForCapped: PasteOp[];
  opsForOverflow: PasteOp[];
  onExecute: (ops: PasteOp[], allowOverflow: boolean) => void;
  onCancel: () => void;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop closes on click; keyboard handled by dialog via Escape
    // biome-ignore lint/a11y/useKeyWithClickEvents: modal backdrop closes on click; keyboard handled by dialog via Escape
    <div className="confirm-overlay" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        className="confirm-dialog paste-conflict-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <p className="confirm-msg">
          ペースト先でキャパシティの上限を超えるセルがあります。
        </p>
        <div className="paste-conflict-list">
          {conflicts.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: order is stable
            <div key={i} className="paste-conflict-item">
              <span className="paste-conflict-location">
                {c.rowLabel} · {c.colLabel}
              </span>
              <span className="paste-conflict-values">
                {fmt(c.sourceValue)} → {fmt(c.cappedValue)}
              </span>
            </div>
          ))}
        </div>
        <div className="confirm-btns">
          <button type="button" className="btn-sm" onClick={onCancel}>
            キャンセル
          </button>
          <button
            type="button"
            className="btn-sm"
            onClick={() => onExecute(opsForCapped, false)}
          >
            自動キャップ
          </button>
          <button
            type="button"
            className="btn-sm"
            onClick={() => onExecute(opsForOverflow, true)}
          >
            上限無視
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

const FEATURE_MAX_VAL = 3;
const COL_W = 148;

export function CapacityView({
  history,
  externalDataVersion,
}: {
  history: HistoryController;
  externalDataVersion: number;
}) {
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const v = localStorage.getItem("roadmap.capacityView.viewMode");
      if (v === "quarter" || v === "month") return v;
    } catch {}
    return "quarter";
  });
  const [capacityAggMode, setCapacityAggMode] =
    useState<CapacityAggMode>("average");
  const [quarters, setQuarters] = useState<Quarter[]>([]);
  const [rangeStart, setRangeStart] = useState<QuarterYQ | null>(() => {
    try {
      const v = localStorage.getItem("roadmap.capacityView.rangeStart");
      return v ? (JSON.parse(v) as QuarterYQ) : null;
    } catch {}
    return null;
  });
  const [rangeEnd, setRangeEnd] = useState<QuarterYQ | null>(() => {
    try {
      const v = localStorage.getItem("roadmap.capacityView.rangeEnd");
      return v ? (JSON.parse(v) as QuarterYQ) : null;
    } catch {}
    return null;
  });
  const rangeInitializedRef = useRef(false);
  const rangeStartRef = useRef(rangeStart);
  rangeStartRef.current = rangeStart;
  const rangeEndRef = useRef(rangeEnd);
  rangeEndRef.current = rangeEnd;
  const [members, setMembers] = useState<Member[]>([]);
  const [initiativeRows, setInitiativeRows] = useState<InitiativeRow[]>([]);
  const [epicRows, setEpicRows] = useState<EpicRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionWarning, setActionWarning] = useState<string | null>(null);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importTsv, setImportTsv] = useState("");
  const [importResult, setImportResult] = useState<{
    success: number;
    skipped: number;
    errors: { row: number; message: string }[];
  } | null>(null);
  const [importing, setImporting] = useState(false);
  const [assigningEpicId, setAssigningEpicId] = useState<number | null>(null);
  const [editingEpicDetails, setEditingEpicDetails] = useState<EpicRow | null>(
    null,
  );
  const [editingInitiativeDetails, setEditingInitiativeDetails] =
    useState<InitiativeRow | null>(null);
  const [dragItem, setDragItem] = useState<DragItem | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState<{
    epicId: number;
    memberId: number;
    memberName: string;
    epicName: string;
  } | null>(null);
  const [capacityConflict, setCapacityConflict] =
    useState<PendingCapacityConflict | null>(null);
  const [maxCapacityOverflow, setMaxCapacityOverflow] =
    useState<PendingMaxCapacityOverflow | null>(null);
  const [highlightTarget, setHighlightTarget] = useState<{
    epicId: number;
    memberId: number;
  } | null>(null);
  const highlightRowRef = useRef<HTMLTableRowElement | null>(null);
  // URLパラメータで指定されたハイライト対象をloadAll完了時に適用するための一時保存
  const pendingHighlightRef = useRef<{
    epicId: number;
    memberId: number;
  } | null>(null);

  // ── Selection / clipboard state ─────────────────────────────────────────
  const [selStartRow, setSelStartRow] = useState<number | null>(null);
  const [selEndRow, setSelEndRow] = useState<number | null>(null);
  const [selStartCol, setSelStartCol] = useState<number | null>(null);
  const [selEndCol, setSelEndCol] = useState<number | null>(null);
  const [selType, setSelType] = useState<CellType | null>(null);
  const [copiedSelection, setCopiedSelection] =
    useState<CopiedSelection | null>(null);
  const [lastGridPasteTarget, setLastGridPasteTarget] =
    useState<GridPasteTarget | null>(null);
  const [editCancelToken, setEditCancelToken] = useState(0);
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);
  const [pasteConflict, setPasteConflict] = useState<PasteConflictState | null>(
    null,
  );

  // Refs for drag tracking (not state - no re-render needed)
  const dragStartRef = useRef<{
    row: number;
    col: number;
    type: CellType;
  } | null>(null);
  const didDragRef = useRef(false);

  // ── Label column resize ──────────────────────────────────────────────────
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
      aria-label="Resize epic name column"
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
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
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

  // Flat list of selectable rows in visual order
  const selectableRows = useMemo<SelectableRow[]>(() => {
    const rows: SelectableRow[] = [];
    for (const initiative of initiativeRows) {
      if (initiative.collapsed) continue;
      const initiativeEpics = epicRows
        .filter((epic) => epic.initiativeId === initiative.id)
        .sort((a, b) => a.position - b.position || a.id - b.id);
      for (const epic of initiativeEpics) {
        rows.push({ type: "epic", epicId: epic.id });
        if (!epic.expanded) continue;
        const assignedMemberIds = new Set<number>();
        for (const monthData of epic.months.values()) {
          for (const a of monthData.memberAllocations) {
            assignedMemberIds.add(a.memberId);
          }
        }
        for (const member of members) {
          if (assignedMemberIds.has(member.id)) {
            rows.push({
              type: "member",
              epicId: epic.id,
              memberId: member.id,
            });
          }
        }
      }
    }
    return rows;
  }, [initiativeRows, epicRows, members]);

  // Map from row key → index in selectableRows
  const rowIndexByKey = useMemo(() => {
    const map = new Map<string, number>();
    selectableRows.forEach((row, i) => {
      if (row.type === "epic") {
        map.set(`f-${row.epicId}`, i);
      } else {
        map.set(`m-${row.epicId}-${row.memberId}`, i);
      }
    });
    return map;
  }, [selectableRows]);

  // Normalized selection rectangle
  const normalizedSel = useMemo<SelectionRect | null>(() => {
    if (
      selStartRow === null ||
      selEndRow === null ||
      selStartCol === null ||
      selEndCol === null ||
      selType === null
    )
      return null;
    return {
      minRow: Math.min(selStartRow, selEndRow),
      maxRow: Math.max(selStartRow, selEndRow),
      minCol: Math.min(selStartCol, selEndCol),
      maxCol: Math.max(selStartCol, selEndCol),
      type: selType,
    };
  }, [selStartRow, selEndRow, selStartCol, selEndCol, selType]);

  const isCellInSel = useCallback(
    (rowIndex: number, colIndex: number, cellType: CellType): boolean => {
      if (!normalizedSel || normalizedSel.type !== cellType) return false;
      return (
        rowIndex >= normalizedSel.minRow &&
        rowIndex <= normalizedSel.maxRow &&
        colIndex >= normalizedSel.minCol &&
        colIndex <= normalizedSel.maxCol
      );
    },
    [normalizedSel],
  );

  const isCellInClipSrc = useCallback(
    (rowIndex: number, colIndex: number, cellType: CellType): boolean => {
      if (
        !copiedSelection ||
        copiedSelection.viewMode !== viewMode ||
        copiedSelection.sourceSel.type !== cellType
      )
        return false;
      const s = copiedSelection.sourceSel;
      return (
        rowIndex >= s.minRow &&
        rowIndex <= s.maxRow &&
        colIndex >= s.minCol &&
        colIndex <= s.maxCol
      );
    },
    [copiedSelection, viewMode],
  );

  const clearSelection = useCallback(() => {
    setSelStartRow(null);
    setSelEndRow(null);
    setSelStartCol(null);
    setSelEndCol(null);
    setSelType(null);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("roadmap.capacityView.viewMode", viewMode);
    } catch {}
  }, [viewMode]);

  useEffect(() => {
    try {
      if (rangeStart !== null)
        localStorage.setItem(
          "roadmap.capacityView.rangeStart",
          JSON.stringify(rangeStart),
        );
    } catch {}
  }, [rangeStart]);

  useEffect(() => {
    try {
      if (rangeEnd !== null)
        localStorage.setItem(
          "roadmap.capacityView.rangeEnd",
          JSON.stringify(rangeEnd),
        );
    } catch {}
  }, [rangeEnd]);

  // ── Initial load ────────────────────────────────────────────────────────

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [qs, eps, fs, ms] = await Promise.all([
      orpc.quarters.list({}),
      orpc.initiatives.list({}),
      orpc.epics.list({}),
      orpc.members.list({}),
    ]);

    const sortedQs = [...qs]
      .map((q) => ({
        ...q,
        months: [...q.months].sort((a, b) => a.month - b.month),
      }))
      .sort((a, b) => a.year - b.year || a.quarter - b.quarter);

    const epicViews = await Promise.all(
      fs.map((f) => orpc.allocations.getEpicView({ epicId: f.id })),
    );

    const rows: EpicRow[] = epicViews.map((fv) => {
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
        id: fv.epic.id,
        name: fv.epic.name,
        description: fv.epic.description,
        initiativeId: fv.epic.initiativeId,
        position: fv.epic.position,
        links: fv.epic.links.map((link) => ({
          id: link.id,
          title: link.title,
          url: link.url,
          position: link.position,
        })),
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
    setMembers(ms);
    setInitiativeRows(
      eps
        .map((initiative) => ({
          id: initiative.id,
          name: initiative.name,
          description: initiative.description,
          position: initiative.position,
          isDefault: initiative.isDefault,
          links: initiative.links.map((link) => ({
            id: link.id,
            title: link.title,
            url: link.url,
            position: link.position,
          })),
          collapsed: false,
        }))
        .sort((a, b) => a.position - b.position || a.id - b.id),
    );
    // pendingHighlightRefがあれば対象フィーチャーを展開し、既存のexpanded状態も保持
    const pending = pendingHighlightRef.current;
    setEpicRows((prevRows) => {
      const expandedIds = new Set(
        prevRows.filter((r) => r.expanded).map((r) => r.id),
      );
      if (pending) expandedIds.add(pending.epicId);
      return rows.map((r) => ({ ...r, expanded: expandedIds.has(r.id) }));
    });
    if (pending) {
      setHighlightTarget(pending);
      pendingHighlightRef.current = null;
    }
    setLoading(false);
  }, []);

  // マウント時にURLパラメータを読み取り、pendingHighlightRefに保存してURLをクリア
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fid = parseInt(params.get("epicId") ?? "", 10);
    const mid = parseInt(params.get("memberId") ?? "", 10);
    if (!Number.isNaN(fid) && !Number.isNaN(mid) && fid > 0 && mid > 0) {
      pendingHighlightRef.current = { epicId: fid, memberId: mid };
      const url = new URL(window.location.href);
      url.searchParams.delete("epicId");
      url.searchParams.delete("memberId");
      window.history.replaceState(null, "", url.toString());
    }
  }, []);

  useEffect(() => {
    void history.version;
    void externalDataVersion;
    loadAll();
  }, [loadAll, history.version, externalDataVersion]);

  // ハイライト行が描画されたらスクロールして、一定時間後にハイライトを消す
  useEffect(() => {
    if (!highlightTarget || !highlightRowRef.current) return;
    highlightRowRef.current.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
    const timer = setTimeout(() => setHighlightTarget(null), 3000);
    return () => clearTimeout(timer);
  }, [highlightTarget]);

  // ── Helpers ──────────────────────────────────────────────────────────────

  const colDivisor = useCallback(
    (column: PeriodColumn): number =>
      capacityAggMode === "average" && column.type === "quarter"
        ? column.monthIds.length
        : 1,
    [capacityAggMode],
  );

  const getColumnData = (row: EpicRow, column: PeriodColumn): MonthData =>
    aggregateMonthData(row.months, column.monthIds);

  const getInitiativeColumnData = (
    initiativeId: number,
    column: PeriodColumn,
  ): MonthData =>
    epicRows
      .filter((epic) => epic.initiativeId === initiativeId)
      .reduce<MonthData>((sum, epic) => {
        const data = getColumnData(epic, column);
        return {
          totalCapacity: sum.totalCapacity + data.totalCapacity,
          unassignedCapacity: sum.unassignedCapacity + data.unassignedCapacity,
          memberAllocations: [],
        };
      }, emptyMonthData());

  const getMemberColumnTotal = (
    memberId: number,
    column: PeriodColumn,
  ): number =>
    epicRows.reduce((sum, row) => {
      const alloc = getColumnData(row, column).memberAllocations.find(
        (a) => a.memberId === memberId,
      );
      return sum + (alloc?.capacity ?? 0);
    }, 0);

  const getMemberMaxCap = useCallback(
    (memberId: number): number =>
      members.find((m) => m.id === memberId)?.maxCapacity ?? 1,
    [members],
  );

  const isMemberColumnOverflow = (
    memberId: number,
    column: PeriodColumn,
  ): boolean =>
    getMemberColumnTotal(memberId, column) >
    columnMemberLimit(column, getMemberMaxCap(memberId)) + 0.000001;

  const getRebalancePreview = (
    memberId: number,
    column: PeriodColumn,
    excludeEpicId: number,
    requestedCapacity: number,
  ): RebalancePreview[] => {
    const otherAllocations = epicRows
      .filter((row) => row.id !== excludeEpicId)
      .map((row) => {
        const alloc = getColumnData(row, column).memberAllocations.find(
          (a) => a.memberId === memberId,
        );
        return {
          epicName: row.name,
          currentCapacity: alloc?.capacity ?? 0,
        };
      })
      .filter((change) => change.currentCapacity > 0);
    const usedElsewhere = otherAllocations.reduce(
      (sum, change) => sum + change.currentCapacity,
      0,
    );
    const limit = columnMemberLimit(column, getMemberMaxCap(memberId));
    const scale =
      requestedCapacity <= limit && usedElsewhere > 0
        ? Math.max(0, (limit - requestedCapacity) / usedElsewhere)
        : 1;

    return otherAllocations.map((change) => ({
      ...change,
      nextCapacity: r2(change.currentCapacity * scale),
    }));
  };

  const getRebalanceAllPreview = (
    memberId: number,
    column: PeriodColumn,
    excludeEpicId: number,
    requestedCapacity: number,
  ): { newCapacity: number; othersPreview: RebalancePreview[] } => {
    const otherAllocations = epicRows
      .filter((row) => row.id !== excludeEpicId)
      .map((row) => {
        const alloc = getColumnData(row, column).memberAllocations.find(
          (a) => a.memberId === memberId,
        );
        return {
          epicName: row.name,
          currentCapacity: alloc?.capacity ?? 0,
        };
      })
      .filter((change) => change.currentCapacity > 0);
    const usedElsewhere = otherAllocations.reduce(
      (sum, change) => sum + change.currentCapacity,
      0,
    );
    const limit = columnMemberLimit(column, getMemberMaxCap(memberId));
    const total = usedElsewhere + requestedCapacity;
    const scale = total > limit ? limit / total : 1;

    return {
      newCapacity: r2(requestedCapacity * scale),
      othersPreview: otherAllocations.map((change) => ({
        ...change,
        nextCapacity: r2(change.currentCapacity * scale),
      })),
    };
  };

  const toggleExpand = (epicId: number) => {
    setEpicRows((rows) =>
      rows.map((r) => (r.id === epicId ? { ...r, expanded: !r.expanded } : r)),
    );
  };

  const toggleInitiativeCollapse = (initiativeId: number) => {
    setInitiativeRows((rows) =>
      rows.map((row) =>
        row.id === initiativeId ? { ...row, collapsed: !row.collapsed } : row,
      ),
    );
  };

  // ── Drag selection handlers ──────────────────────────────────────────────

  const handleCellMouseDown = useCallback(
    (rowIndex: number, colIndex: number, type: CellType) => {
      didDragRef.current = false;
      dragStartRef.current = { row: rowIndex, col: colIndex, type };
      setLastGridPasteTarget({ row: rowIndex, col: colIndex });
      setPasteNotice(null);
      setSelType(type);
      setSelStartRow(rowIndex);
      setSelStartCol(colIndex);
      setSelEndRow(rowIndex);
      setSelEndCol(colIndex);
    },
    [],
  );

  const handleCellMouseEnter = useCallback(
    (rowIndex: number, colIndex: number, type: CellType) => {
      const ds = dragStartRef.current;
      if (!ds || ds.type !== type) return;
      // Once we enter any cell while mousedown is held, it's a drag
      didDragRef.current = true;
      setSelType(type);
      setSelStartRow(ds.row);
      setSelStartCol(ds.col);
      setSelEndRow(rowIndex);
      setSelEndCol(colIndex);
    },
    [],
  );

  // Global mouseup clears drag tracking
  useEffect(() => {
    const onMouseUp = () => {
      dragStartRef.current = null;
    };
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, []);

  // ── API actions ───────────────────────────────────────────────────────────

  const applyEpicMonthUpdates = useCallback((updates: EpicMonthUpdate[]) => {
    setEpicRows((rows) =>
      rows.map((r) => {
        const rowUpdates = updates.filter((u) => u.epicId === r.id);
        if (rowUpdates.length === 0) return r;
        let newMap = new Map(r.months);
        for (const update of rowUpdates) {
          newMap = updateMonthResults(newMap, update.months);
        }
        return { ...r, months: newMap };
      }),
    );
  }, []);

  const updateTotal = useCallback(
    async (epicId: number, column: PeriodColumn, totalCapacity: number) => {
      setBusy(true);
      try {
        await history.record("Capacityを変更", async () => {
          const result = await orpc.allocations.updateTotal({
            epicId,
            totalCapacity,
            periodType: column.type,
            monthId: column.monthId,
            quarterId: column.quarterId,
          });
          applyEpicMonthUpdates([{ epicId, months: result.months }]);
        });
      } finally {
        setBusy(false);
      }
    },
    [applyEpicMonthUpdates, history],
  );

  const updateMemberAllocation = useCallback(
    async (
      epicId: number,
      column: PeriodColumn,
      memberId: number,
      capacity: number,
    ) => {
      setBusy(true);
      try {
        setCapacityConflict(null);
        setMaxCapacityOverflow(null);
        const limit = columnMemberLimit(column, getMemberMaxCap(memberId));

        if (capacity > limit) {
          const usedElsewhere = epicRows
            .filter((row) => row.id !== epicId)
            .reduce((sum, row) => {
              const alloc = aggregateMonthData(
                row.months,
                column.monthIds,
              ).memberAllocations.find((a) => a.memberId === memberId);
              return sum + (alloc?.capacity ?? 0);
            }, 0);
          setMaxCapacityOverflow({
            epicId,
            periodType: column.type,
            monthId: column.monthId,
            quarterId: column.quarterId,
            memberId,
            memberName:
              members.find((member) => member.id === memberId)?.name ??
              "メンバー",
            requestedCapacity: capacity,
            limit,
            usedElsewhere,
          });
          return;
        }

        const preview = await orpc.allocations.previewMemberAllocation({
          epicId,
          memberId,
          capacity,
          periodType: column.type,
          monthId: column.monthId,
          quarterId: column.quarterId,
        });
        if (preview.hasConflict) {
          setCapacityConflict({
            epicId,
            periodType: column.type,
            monthId: column.monthId,
            quarterId: column.quarterId,
            memberId,
            memberName:
              members.find((member) => member.id === memberId)?.name ??
              "メンバー",
            requestedCapacity: capacity,
            usedElsewhere: preview.usedElsewhere,
            assignableCapacity: preview.assignableCapacity,
          });
          return;
        }

        await history.record("Member capacityを変更", async () => {
          const result = await orpc.allocations.updateMemberAllocation({
            epicId,
            memberId,
            capacity,
            periodType: column.type,
            monthId: column.monthId,
            quarterId: column.quarterId,
            capacityConflictResolution: "fitWithinLimit",
          });
          applyEpicMonthUpdates(result.updatedEpics);
        });
      } finally {
        setBusy(false);
      }
    },
    [applyEpicMonthUpdates, members, getMemberMaxCap, epicRows, history],
  );

  const resolveCapacityConflict = useCallback(
    async (resolution: CapacityConflictResolution) => {
      if (!capacityConflict) return;
      setBusy(true);
      try {
        await history.record("Capacity競合を解決", async () => {
          const result = await orpc.allocations.updateMemberAllocation({
            epicId: capacityConflict.epicId,
            periodType: capacityConflict.periodType,
            monthId: capacityConflict.monthId,
            quarterId: capacityConflict.quarterId,
            memberId: capacityConflict.memberId,
            capacity: capacityConflict.requestedCapacity,
            capacityConflictResolution: resolution,
          });
          applyEpicMonthUpdates(result.updatedEpics);
        });
        setCapacityConflict(null);
      } finally {
        setBusy(false);
      }
    },
    [applyEpicMonthUpdates, capacityConflict, history],
  );

  const resolveMaxCapacityOverflow = useCallback(
    async (resolution: "fitWithinLimit" | "allowOverflow") => {
      if (!maxCapacityOverflow) return;
      setBusy(true);
      try {
        await history.record("Max capacity超過を解決", async () => {
          const result = await orpc.allocations.updateMemberAllocation({
            epicId: maxCapacityOverflow.epicId,
            periodType: maxCapacityOverflow.periodType,
            monthId: maxCapacityOverflow.monthId,
            quarterId: maxCapacityOverflow.quarterId,
            memberId: maxCapacityOverflow.memberId,
            capacity: maxCapacityOverflow.requestedCapacity,
            capacityConflictResolution: resolution,
          });
          applyEpicMonthUpdates(result.updatedEpics);
        });
        setMaxCapacityOverflow(null);
      } finally {
        setBusy(false);
      }
    },
    [applyEpicMonthUpdates, maxCapacityOverflow, history],
  );

  // ── Copy / Paste logic ────────────────────────────────────────────────────

  const handleCopy = useCallback(async () => {
    if (!normalizedSel) return;
    const { minRow, maxRow, minCol, maxCol, type } = normalizedSel;
    const data: number[][] = [];

    for (let ri = minRow; ri <= maxRow; ri++) {
      const selRow = selectableRows[ri];
      if (!selRow || selRow.type !== type) continue;
      const rowData: number[] = [];
      const epic = epicRows.find((f) => f.id === selRow.epicId);
      if (!epic) continue;

      for (let ci = minCol; ci <= maxCol; ci++) {
        const column = columns[ci];
        if (!column) continue;
        const div = colDivisor(column);
        if (type === "epic") {
          rowData.push(
            aggregateMonthData(epic.months, column.monthIds).totalCapacity /
              div,
          );
        } else {
          const memberId = (selRow as { type: "member"; memberId: number })
            .memberId;
          const alloc = aggregateMonthData(
            epic.months,
            column.monthIds,
          ).memberAllocations.find((a) => a.memberId === memberId);
          rowData.push((alloc?.capacity ?? 0) / div);
        }
      }
      if (rowData.length > 0) data.push(rowData);
    }

    if (data.length === 0) return;

    const tsv = data.map((row) => row.map((v) => fmt(v)).join("\t")).join("\n");
    try {
      await navigator.clipboard.writeText(tsv);
      setCopiedSelection({ viewMode, sourceSel: normalizedSel });
      setPasteNotice(null);
    } catch {
      setPasteNotice("クリップボードへコピーできませんでした。");
    }
  }, [normalizedSel, selectableRows, epicRows, columns, viewMode, colDivisor]);

  const getMemberUsedElsewhere = useCallback(
    (memberId: number, epicId: number, monthIds: number[]): number => {
      let used = 0;
      for (const epic of epicRows) {
        if (epic.id === epicId) continue;
        for (const monthId of monthIds) {
          const monthData = epic.months.get(monthId);
          if (!monthData) continue;
          const alloc = monthData.memberAllocations.find(
            (a) => a.memberId === memberId,
          );
          if (alloc) used += alloc.capacity;
        }
      }
      return used;
    },
    [epicRows],
  );

  const buildPasteOps = useCallback(
    (
      data: number[][],
      anchorRow: number,
      anchorCol: number,
      type: CellType,
    ): PasteOp[] => {
      const ops: PasteOp[] = [];
      let dataRowIdx = 0;
      for (
        let ri = anchorRow;
        ri < selectableRows.length && dataRowIdx < data.length;
        ri++
      ) {
        const selRow = selectableRows[ri];
        if (!selRow || selRow.type !== type) continue;
        const rowData = data[dataRowIdx++] ?? [];
        for (let ci = 0; ci < rowData.length; ci++) {
          const column = columns[anchorCol + ci];
          if (!column) break; // range clip
          const value = rowData[ci] ?? 0;
          if (type === "epic") {
            ops.push({
              kind: "epic",
              epicId: selRow.epicId,
              column,
              value,
            });
          } else {
            const memberId = (selRow as { type: "member"; memberId: number })
              .memberId;
            ops.push({
              kind: "member",
              epicId: selRow.epicId,
              memberId,
              column,
              value,
            });
          }
        }
      }
      return ops;
    },
    [selectableRows, columns],
  );

  const detectPasteConflicts = useCallback(
    (ops: PasteOp[]): PasteConflictItem[] => {
      const conflicts: PasteConflictItem[] = [];
      for (const op of ops) {
        if (op.kind !== "member") continue;
        const member = members.find((m) => m.id === op.memberId);
        const maxCap = columnMemberLimit(op.column, member?.maxCapacity ?? 1);
        const usedElsewhere = getMemberUsedElsewhere(
          op.memberId,
          op.epicId,
          op.column.monthIds,
        );
        const div = colDivisor(op.column);
        const available = Math.max(0, maxCap - usedElsewhere) / div;
        if (op.value > available + 0.000001) {
          const epic = epicRows.find((f) => f.id === op.epicId);
          conflicts.push({
            rowLabel: `${member?.name ?? "?"} @ ${epic?.name ?? "?"}`,
            colLabel: op.column.label,
            sourceValue: op.value,
            cappedValue: r2(available),
          });
        }
      }
      return conflicts;
    },
    [members, epicRows, getMemberUsedElsewhere, colDivisor],
  );

  const executePaste = useCallback(
    async (ops: PasteOp[], allowOverflow: boolean) => {
      setBusy(true);
      try {
        await history.record("Capacityを貼り付け", async () => {
          for (const op of ops) {
            const div = colDivisor(op.column);
            if (op.kind === "epic") {
              const result = await orpc.allocations.updateTotal({
                epicId: op.epicId,
                totalCapacity: op.value * div,
                periodType: op.column.type,
                monthId: op.column.monthId,
                quarterId: op.column.quarterId,
              });
              applyEpicMonthUpdates([
                { epicId: op.epicId, months: result.months },
              ]);
            } else {
              const result = await orpc.allocations.updateMemberAllocation({
                epicId: op.epicId,
                memberId: op.memberId,
                capacity: op.value * div,
                periodType: op.column.type,
                monthId: op.column.monthId,
                quarterId: op.column.quarterId,
                capacityConflictResolution: allowOverflow
                  ? "allowOverflow"
                  : "fitWithinLimit",
              });
              applyEpicMonthUpdates(result.updatedEpics);
            }
          }
        });
      } finally {
        setBusy(false);
        setPasteConflict(null);
        setCopiedSelection(null);
        setPasteNotice(null);
        clearSelection();
      }
    },
    [applyEpicMonthUpdates, clearSelection, colDivisor, history],
  );

  const handleGridPaste = useCallback(
    async (clipData: number[][], target: GridPasteTarget) => {
      const clipType = selectableRows[target.row]?.type ?? null;
      if (!clipType || !columns[target.col]) {
        setPasteNotice("貼り付け先セルを選択してください。");
        return;
      }

      const ops = buildPasteOps(clipData, target.row, target.col, clipType);
      if (ops.length === 0) {
        setPasteNotice("貼り付け可能な範囲がありません。");
        return;
      }

      const conflicts = detectPasteConflicts(ops);
      if (conflicts.length > 0) {
        const opsForCapped = ops.map((op) => {
          if (op.kind !== "member") return op;
          const member = members.find((m) => m.id === op.memberId);
          const maxCap = columnMemberLimit(op.column, member?.maxCapacity ?? 1);
          const usedElsewhere = getMemberUsedElsewhere(
            op.memberId,
            op.epicId,
            op.column.monthIds,
          );
          const div = colDivisor(op.column);
          const available = Math.max(0, maxCap - usedElsewhere) / div;
          return { ...op, value: Math.min(op.value, r2(available)) };
        });
        setPasteConflict({ conflicts, opsForCapped, opsForOverflow: ops });
      } else {
        await executePaste(ops, false);
      }
    },
    [
      selectableRows,
      columns,
      buildPasteOps,
      detectPasteConflicts,
      executePaste,
      members,
      getMemberUsedElsewhere,
      colDivisor,
    ],
  );

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  useEffect(() => {
    if (!capacityConflict) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCapacityConflict(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [capacityConflict]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setCopiedSelection(null);
        setPasteNotice(null);
        clearSelection();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "c" && normalizedSel) {
        e.preventDefault();
        void handleCopy();
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleCopy, normalizedSel, clearSelection]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const isEditable = isEditablePasteTarget(e.target);
      const isGridValueInput = isGridValuePasteTarget(e.target);
      if (isEditable && !isGridValueInput) return;

      const text = e.clipboardData?.getData("text/plain") ?? "";
      const parsed = parseCapacityTSV(text);
      if (!parsed) {
        if (!isEditable && lastGridPasteTarget) {
          e.preventDefault();
          setPasteNotice("クリップボードに貼り付け可能な数値TSVがありません。");
        }
        return;
      }

      const target =
        lastGridPasteTarget ??
        (normalizedSel
          ? { row: normalizedSel.minRow, col: normalizedSel.minCol }
          : null);
      e.preventDefault();
      if (!target) {
        setPasteNotice("貼り付け先セルを選択してください。");
        return;
      }

      setEditCancelToken((token) => token + 1);
      setPasteNotice(null);
      void handleGridPaste(parsed, target);
    };

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [handleGridPaste, lastGridPasteTarget, normalizedSel]);

  // ── Epic actions ────────────────────────────────────────────────────────

  const addInitiative = async () => {
    setBusy(true);
    setActionWarning(null);
    try {
      const initiative = await orpc.initiatives.create({
        name: nextAvailableGeneratedName(
          "Initiative",
          initiativeRows.map((row) => row.name),
        ),
      });
      if (!initiative) return;
      setInitiativeRows((rows) => [
        ...rows,
        {
          id: initiative.id,
          name: initiative.name,
          description: initiative.description,
          position: initiative.position,
          isDefault: initiative.isDefault,
          links: initiative.links,
          collapsed: false,
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

  const addEpic = async (initiativeId: number) => {
    setBusy(true);
    setActionWarning(null);
    try {
      const f = await history.record("Epicを追加", async () => {
        return orpc.epics.create({
          initiativeId,
          name: nextAvailableGeneratedName(
            "Epic",
            epicRows.map((row) => row.name),
          ),
        });
      });
      if (!f) return;
      setEpicRows((rows) => [
        ...rows,
        {
          id: f.id,
          name: f.name,
          description: f.description,
          initiativeId: f.initiativeId,
          position: f.position,
          links: f.links,
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

  const renameInitiative = useCallback(async (id: number, name: string) => {
    const initiative = await orpc.initiatives.rename({ id, name });
    if (!initiative) return name;
    setInitiativeRows((rows) =>
      rows.map((row) =>
        row.id === id
          ? {
              ...row,
              name: initiative.name,
              description: initiative.description,
              links: initiative.links,
            }
          : row,
      ),
    );
    return initiative.name;
  }, []);

  const renameEpic = useCallback(
    async (id: number, name: string) => {
      const f = await history.record("Epic名を変更", async () => {
        return orpc.epics.rename({ id, name });
      });
      if (!f) return name;
      setEpicRows((rows) =>
        rows.map((r) =>
          r.id === id
            ? {
                ...r,
                name: f.name,
                description: f.description,
                initiativeId: f.initiativeId,
                position: f.position,
                links: f.links,
              }
            : r,
        ),
      );
      return f.name;
    },
    [history],
  );

  const saveEpicDetails = useCallback(
    async (
      id: number,
      input: {
        name: string;
        initiativeId: number;
        description: string | null;
        links: Array<{ title: string; url: string }>;
      },
    ) => {
      const f = await history.record("Epic詳細を変更", async () => {
        return orpc.epics.rename({ id, ...input });
      });
      if (!f) return;
      setEpicRows((rows) =>
        rows.map((r) =>
          r.id === id
            ? {
                ...r,
                name: f.name,
                description: f.description,
                initiativeId: f.initiativeId,
                position: f.position,
                links: f.links,
              }
            : r,
        ),
      );
      setEditingEpicDetails((current) =>
        current?.id === id
          ? {
              ...current,
              name: f.name,
              initiativeId: f.initiativeId,
              position: f.position,
              description: f.description,
              links: f.links,
            }
          : current,
      );
    },
    [history],
  );

  const saveInitiativeDetails = useCallback(
    async (
      id: number,
      input: {
        name: string;
        description: string | null;
        links: Array<{ title: string; url: string }>;
      },
    ) => {
      const initiative = await orpc.initiatives.rename({ id, ...input });
      if (!initiative) return;
      setInitiativeRows((rows) =>
        rows.map((row) =>
          row.id === id
            ? {
                ...row,
                name: initiative.name,
                description: initiative.description,
                links: initiative.links,
              }
            : row,
        ),
      );
      setEditingInitiativeDetails((current) =>
        current?.id === id
          ? {
              ...current,
              name: initiative.name,
              description: initiative.description,
              links: initiative.links,
            }
          : current,
      );
    },
    [],
  );

  const deleteEpic = useCallback(
    async (id: number) => {
      setBusy(true);
      try {
        await history.record("Epicを削除", async () => {
          await orpc.epics.delete({ id });
          setEpicRows((rows) => rows.filter((r) => r.id !== id));
        });
      } finally {
        setBusy(false);
      }
    },
    [history],
  );

  const deleteInitiative = useCallback(async (id: number) => {
    setBusy(true);
    setActionWarning(null);
    try {
      await orpc.initiatives.delete({ id });
      setInitiativeRows((rows) => rows.filter((row) => row.id !== id));
    } catch (error) {
      setActionWarning(
        error instanceof Error
          ? error.message
          : "Initiativeを削除できませんでした。",
      );
    } finally {
      setBusy(false);
    }
  }, []);

  const moveInitiative = useCallback(
    async (initiativeId: number, beforeId: number) => {
      if (initiativeId === beforeId) return;
      const updated = await orpc.initiatives.move({
        id: initiativeId,
        beforeId,
      });
      setInitiativeRows((rows) => {
        const collapsedById = new Map(
          rows.map((row) => [row.id, row.collapsed]),
        );
        return updated.map((initiative) => ({
          id: initiative.id,
          name: initiative.name,
          description: initiative.description,
          position: initiative.position,
          isDefault: initiative.isDefault,
          links: initiative.links,
          collapsed: collapsedById.get(initiative.id) ?? false,
        }));
      });
    },
    [],
  );

  const moveEpic = useCallback(
    async (epicId: number, initiativeId: number, beforeId?: number) => {
      const moved = await orpc.epics.move({
        id: epicId,
        initiativeId,
        beforeId,
      });
      if (!moved) return;
      await loadAll();
    },
    [loadAll],
  );

  const addMember = async () => {
    setBusy(true);
    setActionWarning(null);
    try {
      const m = await history.record("Memberを追加", async () => {
        return orpc.members.create({
          name: nextAvailableGeneratedName(
            "Member",
            members.map((member) => member.name),
          ),
        });
      });
      if (!m) return;
      setMembers((ms) => [...ms, m]);
    } catch (error) {
      const message = getNameErrorMessage(error);
      if (message) setActionWarning(message);
      else throw error;
    } finally {
      setBusy(false);
    }
  };

  const applyRange = async (start: QuarterYQ, end: QuarterYQ) => {
    if (start.year * 4 + start.quarter > end.year * 4 + end.quarter) return;
    setRangeStart(start);
    setRangeEnd(end);

    // Create any quarters in the range that don't yet exist in the DB
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

  const refreshEpicRow = useCallback(async (epicId: number) => {
    const fv = await orpc.allocations.getEpicView({ epicId });
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
    setEpicRows((rows) =>
      rows.map((r) =>
        r.id === epicId
          ? {
              ...r,
              name: fv.epic.name,
              description: fv.epic.description,
              initiativeId: fv.epic.initiativeId,
              position: fv.epic.position,
              links: fv.epic.links,
              months: monthMap,
            }
          : r,
      ),
    );
  }, []);

  const assignMemberToEpic = useCallback(
    async (epicId: number, memberId: number) => {
      setBusy(true);
      try {
        await history.record("MemberをEpicに割り当て", async () => {
          await orpc.allocations.assignMember({ epicId, memberId });
          await refreshEpicRow(epicId);
        });
      } finally {
        setBusy(false);
      }
    },
    [refreshEpicRow, history],
  );

  const removeMemberFromEpic = useCallback(
    async (epicId: number, memberId: number) => {
      setBusy(true);
      try {
        await history.record("MemberをEpicから削除", async () => {
          await orpc.allocations.removeMemberFromEpic({
            epicId,
            memberId,
          });
          await refreshEpicRow(epicId);
        });
      } finally {
        setBusy(false);
      }
    },
    [refreshEpicRow, history],
  );

  const copyAllocationTSV = useCallback(async () => {
    const tsv = await orpc.export.allocationTSV({});
    await navigator.clipboard.writeText(tsv);
  }, []);

  const runImportTSV = useCallback(async () => {
    setImporting(true);
    try {
      const result = await orpc.import.tsvImport({ tsv: importTsv });
      setImportResult(result);
      if (result.success > 0) {
        history.clear();
        await loadAll();
      }
    } finally {
      setImporting(false);
    }
  }, [importTsv, loadAll, history]);

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
              onClick={() => navigate("/epics")}
            >
              Epics
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
            className="cv-nav-link active"
            onClick={() => navigate("/epics")}
          >
            Epics
          </button>
          <button
            type="button"
            className="cv-nav-link"
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
        {copiedSelection && copiedSelection.viewMode === viewMode && (
          <span
            style={{ marginLeft: 8, fontSize: 11, color: "var(--cv-accent)" }}
          >
            コピー済み · Ctrl+Vでペースト / Escで解除
          </span>
        )}
      </header>

      <div className="cv-body">
        <div className="cv-table-wrapper">
          <table
            className="cv-table"
            style={{ width: labelWidth + columns.length * COL_W }}
          >
            <thead>
              <tr>
                <th className="th-label">
                  Epic
                  {renderLabelResizeBorder()}
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
              {initiativeRows.flatMap((initiative, initiativeIndex) => {
                const rows: React.ReactNode[] = [];
                const initiativeEpics = epicRows
                  .filter((epic) => epic.initiativeId === initiative.id)
                  .sort((a, b) => a.position - b.position || a.id - b.id);
                const initiativeHasOverflow = columns.some(
                  (column) =>
                    getInitiativeColumnData(initiative.id, column)
                      .unassignedCapacity > 0,
                );
                if (initiativeIndex > 0) {
                  rows.push(
                    <tr
                      key={`initiative-sep-${initiative.id}`}
                      className="cv-section-sep"
                    >
                      <td colSpan={columns.length + 1} />
                    </tr>,
                  );
                }
                rows.push(
                  <tr
                    key={`initiative-${initiative.id}`}
                    className="tr-initiative"
                    onDragOver={(e) => {
                      if (dragItem) e.preventDefault();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragItem?.type === "epic") {
                        void moveEpic(dragItem.epicId, initiative.id);
                      }
                      if (dragItem?.type === "initiative") {
                        void moveInitiative(
                          dragItem.initiativeId,
                          initiative.id,
                        );
                      }
                      setDragItem(null);
                    }}
                  >
                    <td className="td-label">
                      <div className="td-label-inner">
                        <button
                          type="button"
                          className="drag-handle"
                          draggable
                          onDragStart={() =>
                            setDragItem({
                              type: "initiative",
                              initiativeId: initiative.id,
                            })
                          }
                          onDragEnd={() => setDragItem(null)}
                          title="Initiativeを移動"
                          aria-label="Initiativeを移動"
                        >
                          <GripVertical size={14} />
                        </button>
                        <button
                          type="button"
                          className="toggle-btn"
                          onClick={() =>
                            toggleInitiativeCollapse(initiative.id)
                          }
                          title={initiative.collapsed ? "展開" : "折りたたむ"}
                        >
                          {initiative.collapsed ? "+" : "−"}
                        </button>
                        <EpicNameCell
                          name={initiative.name}
                          hasDescription={
                            (initiative.description?.trim().length ?? 0) > 0
                          }
                          links={initiative.links}
                          onRename={(name) =>
                            renameInitiative(initiative.id, name)
                          }
                          onDelete={() => deleteInitiative(initiative.id)}
                          onEditDetails={() =>
                            setEditingInitiativeDetails(initiative)
                          }
                        />
                        {initiativeHasOverflow && (
                          <span
                            className="overflow-dot"
                            title="未アサインあり"
                          />
                        )}
                      </div>
                      {renderLabelResizeBorder()}
                    </td>
                    {columns.map((column) => {
                      const data = getInitiativeColumnData(
                        initiative.id,
                        column,
                      );
                      const div = colDivisor(column);
                      const { bg, fg } = heatBg(
                        data.totalCapacity / div,
                        FEATURE_MAX_VAL / div,
                      );
                      return (
                        <td
                          key={column.key}
                          className="td-quarter initiative-total-cell"
                          style={{
                            width: COL_W,
                            minWidth: COL_W,
                            background: bg,
                          }}
                        >
                          <span
                            className="hm-val"
                            style={{
                              color:
                                data.totalCapacity === 0 ? "transparent" : fg,
                            }}
                          >
                            {fmt(data.totalCapacity / div)}
                          </span>
                          {data.unassignedCapacity > 0 && (
                            <span className="initiative-overflow-dot" />
                          )}
                        </td>
                      );
                    })}
                  </tr>,
                );
                if (initiative.collapsed) return rows;

                for (const epic of initiativeEpics) {
                  const hasOverflow = columns.some(
                    (column) =>
                      (getColumnData(epic, column).unassignedCapacity ?? 0) > 0,
                  );
                  const epicRowIndex = rowIndexByKey.get(`f-${epic.id}`) ?? -1;

                  rows.push(
                    <tr
                      key={epic.id}
                      className="tr-epic tr-capacity-epic"
                      onDragOver={(e) => {
                        if (dragItem) e.preventDefault();
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (dragItem?.type === "epic") {
                          void moveEpic(
                            dragItem.epicId,
                            epic.initiativeId,
                            epic.id,
                          );
                        }
                        if (dragItem?.type === "initiative") {
                          void moveInitiative(
                            dragItem.initiativeId,
                            initiative.id,
                          );
                        }
                        setDragItem(null);
                      }}
                    >
                      <td className="td-label">
                        <div className="td-label-inner">
                          <button
                            type="button"
                            className="drag-handle"
                            draggable
                            onDragStart={() =>
                              setDragItem({
                                type: "epic",
                                epicId: epic.id,
                                initiativeId: epic.initiativeId,
                              })
                            }
                            onDragEnd={() => setDragItem(null)}
                            title="Epicを移動"
                            aria-label="Epicを移動"
                          >
                            <GripVertical size={14} />
                          </button>
                          <button
                            type="button"
                            className="toggle-btn"
                            onClick={() => toggleExpand(epic.id)}
                            title={epic.expanded ? "折りたたむ" : "詳細を展開"}
                          >
                            {epic.expanded ? "−" : "+"}
                          </button>
                          <EpicNameCell
                            name={epic.name}
                            hasDescription={
                              (epic.description?.trim().length ?? 0) > 0
                            }
                            links={epic.links}
                            onRename={(name) => renameEpic(epic.id, name)}
                            onDelete={() => deleteEpic(epic.id)}
                            onEditDetails={() => setEditingEpicDetails(epic)}
                          />
                          {hasOverflow && (
                            <span
                              className="overflow-dot"
                              title="未アサインあり"
                            />
                          )}
                        </div>
                        {renderLabelResizeBorder()}
                      </td>
                      {columns.map((column, ci) => {
                        const data = getColumnData(epic, column);
                        const selected = isCellInSel(epicRowIndex, ci, "epic");
                        const copied = isCellInClipSrc(
                          epicRowIndex,
                          ci,
                          "epic",
                        );
                        return (
                          <td
                            key={column.key}
                            className="td-quarter"
                            style={{ width: COL_W, minWidth: COL_W }}
                          >
                            <HeatmapCell
                              value={data.totalCapacity / colDivisor(column)}
                              unassigned={
                                data.unassignedCapacity / colDivisor(column)
                              }
                              maxVal={FEATURE_MAX_VAL / colDivisor(column)}
                              onCommit={(v) =>
                                updateTotal(
                                  epic.id,
                                  column,
                                  v * colDivisor(column),
                                )
                              }
                              rowHeight={42}
                              isSelected={selected}
                              isCopied={copied}
                              editCancelToken={editCancelToken}
                              onCellMouseDown={() =>
                                handleCellMouseDown(epicRowIndex, ci, "epic")
                              }
                              onCellMouseEnter={() =>
                                handleCellMouseEnter(epicRowIndex, ci, "epic")
                              }
                            />
                          </td>
                        );
                      })}
                    </tr>,
                  );

                  if (epic.expanded) {
                    const assignedMemberIds = new Set<number>();
                    for (const monthData of epic.months.values()) {
                      for (const a of monthData.memberAllocations) {
                        assignedMemberIds.add(a.memberId);
                      }
                    }
                    const assignedMembers = members.filter((m) =>
                      assignedMemberIds.has(m.id),
                    );

                    for (const member of assignedMembers) {
                      const memberRowIndex =
                        rowIndexByKey.get(`m-${epic.id}-${member.id}`) ?? -1;
                      const isOverflow = columns.some((column) => {
                        return (
                          isMemberColumnOverflow(member.id, column) ||
                          (capacityConflict?.epicId === epic.id &&
                            capacityConflict.memberId === member.id &&
                            capacityConflict.periodType === column.type &&
                            capacityConflict.monthId === column.monthId &&
                            capacityConflict.quarterId === column.quarterId)
                        );
                      });

                      const isHighlighted =
                        highlightTarget?.epicId === epic.id &&
                        highlightTarget?.memberId === member.id;
                      rows.push(
                        <tr
                          key={`${epic.id}-${member.id}`}
                          ref={isHighlighted ? highlightRowRef : null}
                          className={`tr-member${isOverflow ? " is-overflow" : ""}${isHighlighted ? " is-highlighted" : ""}`}
                        >
                          <td className="td-label td-member-label">
                            <div className="member-label-row">
                              <span className="member-name">{member.name}</span>
                              <button
                                type="button"
                                className="del-member-btn"
                                onClick={() =>
                                  setRemoveConfirm({
                                    epicId: epic.id,
                                    memberId: member.id,
                                    memberName: member.name,
                                    epicName: epic.name,
                                  })
                                }
                                title="このEpicから削除"
                              >
                                ×
                              </button>
                            </div>
                            {renderLabelResizeBorder()}
                          </td>
                          {columns.map((column, ci) => {
                            const data = getColumnData(epic, column);
                            const alloc = data.memberAllocations.find(
                              (a) => a.memberId === member.id,
                            );
                            const matchingCapacityConflict =
                              capacityConflict &&
                              capacityConflict.epicId === epic.id &&
                              capacityConflict.periodType === column.type &&
                              capacityConflict.monthId === column.monthId &&
                              capacityConflict.quarterId === column.quarterId &&
                              capacityConflict.memberId === member.id
                                ? capacityConflict
                                : null;
                            const matchingMaxCapacityOverflow =
                              maxCapacityOverflow &&
                              maxCapacityOverflow.epicId === epic.id &&
                              maxCapacityOverflow.periodType === column.type &&
                              maxCapacityOverflow.monthId === column.monthId &&
                              maxCapacityOverflow.quarterId ===
                                column.quarterId &&
                              maxCapacityOverflow.memberId === member.id
                                ? maxCapacityOverflow
                                : null;
                            const limit = columnMemberLimit(
                              column,
                              getMemberMaxCap(member.id),
                            );
                            const rawValue =
                              matchingMaxCapacityOverflow?.requestedCapacity ??
                              matchingCapacityConflict?.requestedCapacity ??
                              alloc?.capacity ??
                              0;
                            const div = colDivisor(column);
                            const value = rawValue / div;
                            const displayLimit = limit / div;
                            const cellOv =
                              !!matchingCapacityConflict ||
                              !!matchingMaxCapacityOverflow ||
                              isMemberColumnOverflow(member.id, column);
                            const selected = isCellInSel(
                              memberRowIndex,
                              ci,
                              "member",
                            );
                            const copied = isCellInClipSrc(
                              memberRowIndex,
                              ci,
                              "member",
                            );
                            return (
                              <td
                                key={column.key}
                                className="td-member-val"
                                style={{ width: COL_W, padding: 0 }}
                              >
                                <HeatmapMemberCell
                                  value={value}
                                  maxVal={displayLimit}
                                  isOverflow={cellOv}
                                  onCommit={(v) =>
                                    updateMemberAllocation(
                                      epic.id,
                                      column,
                                      member.id,
                                      v * div,
                                    )
                                  }
                                  isSelected={selected}
                                  isCopied={copied}
                                  editCancelToken={editCancelToken}
                                  onCellMouseDown={() =>
                                    handleCellMouseDown(
                                      memberRowIndex,
                                      ci,
                                      "member",
                                    )
                                  }
                                  onCellMouseEnter={() =>
                                    handleCellMouseEnter(
                                      memberRowIndex,
                                      ci,
                                      "member",
                                    )
                                  }
                                />
                                {matchingMaxCapacityOverflow && (
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
                                    displayDivisor={colDivisor(column)}
                                  />
                                )}
                                {matchingCapacityConflict && (
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
                                      matchingCapacityConflict.memberId,
                                      column,
                                      matchingCapacityConflict.epicId,
                                      matchingCapacityConflict.requestedCapacity,
                                    )}
                                    rebalanceAllPreview={getRebalanceAllPreview(
                                      matchingCapacityConflict.memberId,
                                      column,
                                      matchingCapacityConflict.epicId,
                                      matchingCapacityConflict.requestedCapacity,
                                    )}
                                    onResolve={resolveCapacityConflict}
                                    onCancel={() => setCapacityConflict(null)}
                                    displayDivisor={colDivisor(column)}
                                  />
                                )}
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
                        key={`${epic.id}-assign`}
                        className="tr-assign-member"
                      >
                        <td className="td-assign td-assign-member">
                          {assigningEpicId === epic.id ? (
                            <select
                              className="assign-select"
                              // biome-ignore lint/a11y/noAutofocus: intentional focus for inline dropdown
                              autoFocus
                              defaultValue=""
                              onChange={(e) => {
                                const id = Number(e.target.value);
                                if (id) assignMemberToEpic(epic.id, id);
                                setAssigningEpicId(null);
                              }}
                              onBlur={() => setAssigningEpicId(null)}
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
                              onClick={() => setAssigningEpicId(epic.id)}
                            >
                              + メンバーを割り当て
                            </button>
                          )}
                          {renderLabelResizeBorder()}
                        </td>
                        {columns.length > 0 && <td colSpan={columns.length} />}
                      </tr>,
                    );

                    if (hasOverflow) {
                      rows.push(
                        <tr
                          key={`${epic.id}-ua`}
                          className="tr-unassigned-member"
                        >
                          <td className="td-label td-unassigned-label">
                            <span className="unassigned-name">未アサイン</span>
                            {renderLabelResizeBorder()}
                          </td>
                          {columns.map((column) => {
                            const uv =
                              getColumnData(epic, column).unassignedCapacity /
                              colDivisor(column);
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
                }

                rows.push(
                  <tr
                    key={`initiative-${initiative.id}-add`}
                    className="tr-assign-member"
                  >
                    <td className="td-assign">
                      <button
                        type="button"
                        className="btn-assign"
                        disabled={busy}
                        onClick={() => addEpic(initiative.id)}
                      >
                        + Epic
                      </button>
                      {renderLabelResizeBorder()}
                    </td>
                    {columns.length > 0 && <td colSpan={columns.length} />}
                  </tr>,
                );

                return rows;
              })}
            </tbody>
          </table>
        </div>

        <div className="cv-toolbar">
          <button
            type="button"
            className="btn-sm"
            onClick={addInitiative}
            disabled={busy}
          >
            + Initiative
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
            onClick={copyAllocationTSV}
            disabled={busy}
            title="機能・担当者・キャパシティ・月次形式のTSVをコピー"
          >
            TSVをコピー
          </button>
          <button
            type="button"
            className="btn-sm"
            onClick={() => {
              setImportTsv("");
              setImportResult(null);
              setImportModalOpen(true);
            }}
            disabled={busy}
            title="TSVをインポート（機能\t担当者\tキャパシティ\t月）"
          >
            TSVをインポート
          </button>
          {(pasteNotice || actionWarning || history.warning) && (
            <span className="name-action-warning" role="alert">
              {pasteNotice || actionWarning || history.warning}
            </span>
          )}
          <span className="hint-text">
            ドラッグで範囲選択 · Ctrl+C コピー · Ctrl+V ペースト
          </span>
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
              ヘッダー行（機能・担当者・キャパシティ・月）を含むTSVを貼り付けてください。
              スプレッドシートからのコピーをそのまま貼り付けられます。
              既存のキャパシティに加算されます。
            </p>
            {!importResult ? (
              <textarea
                className="import-textarea"
                value={importTsv}
                onChange={(e) => setImportTsv(e.target.value)}
                placeholder={
                  "機能\t担当者\tキャパシティ\t月\nEpic A\tAlice\t0.5\t2026-04"
                }
                rows={8}
                disabled={importing}
              />
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
                        行{e.row}: {e.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className="confirm-btns">
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
                  className="btn-sm"
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

      {editingEpicDetails && (
        <EpicDetailsDialog
          epic={editingEpicDetails}
          initiatives={initiativeRows}
          onSave={(input) => saveEpicDetails(editingEpicDetails.id, input)}
          onClose={() => setEditingEpicDetails(null)}
        />
      )}

      {editingInitiativeDetails && (
        <InitiativeDetailsDialog
          initiative={editingInitiativeDetails}
          onSave={(input) =>
            saveInitiativeDetails(editingInitiativeDetails.id, input)
          }
          onClose={() => setEditingInitiativeDetails(null)}
        />
      )}

      {removeConfirm && (
        // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop closes on click; keyboard handled by dialog via Escape
        // biome-ignore lint/a11y/useKeyWithClickEvents: modal backdrop closes on click; keyboard handled by dialog via Escape
        <div className="confirm-overlay" onClick={() => setRemoveConfirm(null)}>
          <div
            role="dialog"
            aria-modal="true"
            className="confirm-dialog"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") setRemoveConfirm(null);
            }}
          >
            <p className="confirm-msg">
              「{removeConfirm.memberName}」を「{removeConfirm.epicName}
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
                  removeMemberFromEpic(
                    removeConfirm.epicId,
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

      {pasteConflict && (
        <PasteConflictDialog
          conflicts={pasteConflict.conflicts}
          opsForCapped={pasteConflict.opsForCapped}
          opsForOverflow={pasteConflict.opsForOverflow}
          onExecute={(ops, allowOverflow) =>
            void executePaste(ops, allowOverflow)
          }
          onCancel={() => setPasteConflict(null)}
        />
      )}
    </div>
  );
}
