import {
  ChevronDown,
  ChevronRight,
  GripVertical,
  MoreHorizontal,
  Plus,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import "./capacity.css";
import type { HistoryController } from "./history-client";
import {
  getNameErrorMessage,
  nextAvailableGeneratedName,
  trimSqliteSpaces,
} from "./name-errors";
import { navigate } from "./navigate";
import { orpc } from "./orpc-client";

// ── Types ──────────────────────────────────────────────────────────────────

type Vision = {
  id: number;
  name: string;
  description: string | null;
  position: number;
  expanded: boolean;
};

type StrategicIntent = {
  id: number;
  visionId: number;
  name: string;
  description: string | null;
  position: number;
  expanded: boolean;
};

type Initiative = {
  id: number;
  name: string;
  description: string | null;
  strategicIntentId: number | null;
  position: number;
  expanded: boolean;
};

type Epic = {
  id: number;
  name: string;
  initiativeId: number;
  position: number;
};

type EditingNode =
  | { type: "vision"; id: number }
  | { type: "si"; id: number }
  | { type: "initiative"; id: number };

type DescDialog = {
  type: "vision" | "si" | "initiative";
  id: number;
  name: string;
  value: string;
};

type DeleteDialog = {
  type: "vision" | "si" | "initiative";
  id: number;
  name: string;
  warning: string;
};

type DragItem =
  | { type: "vision"; id: number }
  | { type: "si"; id: number; visionId: number }
  | { type: "initiative"; id: number; strategicIntentId: number | null };

// ── Props ──────────────────────────────────────────────────────────────────

type Props = {
  history: HistoryController;
  externalDataVersion: number;
};

// ── Component ──────────────────────────────────────────────────────────────

export function StrategyTreeView({ externalDataVersion }: Props) {
  const [visions, setVisions] = useState<Vision[]>([]);
  const [strategicIntents, setStrategicIntents] = useState<StrategicIntent[]>(
    [],
  );
  const [initiatives, setInitiatives] = useState<Initiative[]>([]);
  const [epics, setEpics] = useState<Epic[]>([]);
  const [loading, setLoading] = useState(true);

  // Editing state
  const [editingNode, setEditingNode] = useState<EditingNode | null>(null);
  const [editingName, setEditingName] = useState("");
  const [editingError, setEditingError] = useState<string | null>(null);
  const editingInputRef = useRef<HTMLInputElement>(null);

  // Dialogs
  const [descDialog, setDescDialog] = useState<DescDialog | null>(null);
  const [descSaving, setDescSaving] = useState(false);
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialog | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Context menus
  const [menuNode, setMenuNode] = useState<{
    type: "vision" | "si" | "initiative";
    id: number;
  } | null>(null);

  // Drag & drop
  const [dragItem, setDragItem] = useState<DragItem | null>(null);
  const [dropTargetId, setDropTargetId] = useState<number | null>(null);

  // Move initiative dialog
  const [moveDialog, setMoveDialog] = useState<{
    id: number;
    name: string;
    currentSiId: number | null;
    targetSiId: number | null;
  } | null>(null);

  // ── Data loading ──────────────────────────────────────────────────────────

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [vs, sis, inits, eps] = await Promise.all([
        orpc.visions.list({}),
        orpc.strategicIntents.list({}),
        orpc.initiatives.list({}),
        orpc.epics.list({}),
      ]);
      setVisions(vs.map((v) => ({ ...v, expanded: true })));
      setStrategicIntents(sis.map((si) => ({ ...si, expanded: true })));
      setInitiatives(
        inits.map((i) => ({
          id: i.id,
          name: i.name,
          description: i.description,
          strategicIntentId: i.strategicIntentId ?? null,
          position: i.position,
          expanded: false,
        })),
      );
      setEpics(
        eps.map((e) => ({
          id: e.id,
          name: e.name,
          initiativeId: e.initiativeId,
          position: e.position,
        })),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: externalDataVersion triggers reload
  useEffect(() => {
    void loadAll();
  }, [loadAll, externalDataVersion]);

  // ── Inline editing ────────────────────────────────────────────────────────

  function startEdit(node: EditingNode, currentName: string) {
    setEditingNode(node);
    setEditingName(currentName);
    setEditingError(null);
    setMenuNode(null);
    setTimeout(() => editingInputRef.current?.select(), 0);
  }

  function cancelEdit() {
    setEditingNode(null);
    setEditingName("");
    setEditingError(null);
  }

  async function commitEdit() {
    if (!editingNode) return;
    const name = trimSqliteSpaces(editingName);
    if (name.length === 0) {
      setEditingError("名前は空にできません。");
      return;
    }
    try {
      if (editingNode.type === "vision") {
        const updated = await orpc.visions.update({
          id: editingNode.id,
          name,
        });
        if (updated) {
          setVisions((vs) =>
            vs.map((v) =>
              v.id === editingNode.id ? { ...v, name: updated.name } : v,
            ),
          );
        }
      } else if (editingNode.type === "si") {
        const updated = await orpc.strategicIntents.update({
          id: editingNode.id,
          name,
        });
        if (updated) {
          setStrategicIntents((sis) =>
            sis.map((si) =>
              si.id === editingNode.id ? { ...si, name: updated.name } : si,
            ),
          );
        }
      } else {
        const updated = await orpc.initiatives.rename({
          id: editingNode.id,
          name,
        });
        if (updated) {
          setInitiatives((inits) =>
            inits.map((i) =>
              i.id === editingNode.id ? { ...i, name: updated.name } : i,
            ),
          );
        }
      }
      cancelEdit();
    } catch (error) {
      setEditingError(
        getNameErrorMessage(error) ?? "保存できませんでした。",
      );
    }
  }

  // ── Description dialog ────────────────────────────────────────────────────

  function openDescDialog(
    type: DescDialog["type"],
    id: number,
    name: string,
    description: string | null,
  ) {
    setDescDialog({ type, id, name, value: description ?? "" });
    setMenuNode(null);
  }

  async function saveDesc() {
    if (!descDialog) return;
    setDescSaving(true);
    try {
      const desc = descDialog.value.trim() || null;
      if (descDialog.type === "vision") {
        const updated = await orpc.visions.update({
          id: descDialog.id,
          name: descDialog.name,
          description: desc,
        });
        if (updated) {
          setVisions((vs) =>
            vs.map((v) =>
              v.id === descDialog.id
                ? { ...v, description: updated.description ?? null }
                : v,
            ),
          );
        }
      } else if (descDialog.type === "si") {
        const updated = await orpc.strategicIntents.update({
          id: descDialog.id,
          name: descDialog.name,
          description: desc,
        });
        if (updated) {
          setStrategicIntents((sis) =>
            sis.map((si) =>
              si.id === descDialog.id
                ? { ...si, description: updated.description ?? null }
                : si,
            ),
          );
        }
      } else {
        const updated = await orpc.initiatives.rename({
          id: descDialog.id,
          name: descDialog.name,
          description: desc,
        });
        if (updated) {
          setInitiatives((inits) =>
            inits.map((i) =>
              i.id === descDialog.id
                ? { ...i, description: updated.description ?? null }
                : i,
            ),
          );
        }
      }
      setDescDialog(null);
    } catch {
      /* ignore */
    } finally {
      setDescSaving(false);
    }
  }

  // ── Delete dialog ─────────────────────────────────────────────────────────

  function openDeleteDialog(
    type: DeleteDialog["type"],
    id: number,
    name: string,
  ) {
    let warning = "";
    if (type === "vision") {
      const siCount = strategicIntents.filter((si) => si.visionId === id)
        .length;
      if (siCount > 0) {
        warning = `この Vision には ${siCount} 件の Strategic Intent が含まれます。削除すると紐付く Initiative の関連も解除されます。`;
      }
    } else if (type === "si") {
      const initCount = initiatives.filter(
        (i) => i.strategicIntentId === id,
      ).length;
      if (initCount > 0) {
        warning = `この Strategic Intent には ${initCount} 件の Initiative が紐付いています。削除すると未分類になります。`;
      }
    }
    setDeleteDialog({ type, id, name, warning });
    setMenuNode(null);
  }

  async function confirmDelete() {
    if (!deleteDialog) return;
    setDeleting(true);
    try {
      if (deleteDialog.type === "vision") {
        await orpc.visions.delete({ id: deleteDialog.id });
        setVisions((vs) => vs.filter((v) => v.id !== deleteDialog.id));
        setStrategicIntents((sis) =>
          sis.filter((si) => si.visionId !== deleteDialog.id),
        );
        setInitiatives((inits) =>
          inits.map((i) => {
            const si = strategicIntents.find(
              (si) => si.id === i.strategicIntentId,
            );
            if (si?.visionId === deleteDialog.id) {
              return { ...i, strategicIntentId: null };
            }
            return i;
          }),
        );
      } else if (deleteDialog.type === "si") {
        await orpc.strategicIntents.delete({ id: deleteDialog.id });
        setStrategicIntents((sis) =>
          sis.filter((si) => si.id !== deleteDialog.id),
        );
        setInitiatives((inits) =>
          inits.map((i) =>
            i.strategicIntentId === deleteDialog.id
              ? { ...i, strategicIntentId: null }
              : i,
          ),
        );
      } else {
        await orpc.initiatives.delete({ id: deleteDialog.id });
        setInitiatives((inits) =>
          inits.filter((i) => i.id !== deleteDialog.id),
        );
      }
      setDeleteDialog(null);
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : "削除できませんでした。";
      alert(msg);
    } finally {
      setDeleting(false);
    }
  }

  // ── Create handlers ───────────────────────────────────────────────────────

  async function createVision() {
    const name = nextAvailableGeneratedName(
      "Vision",
      visions.map((v) => v.name),
    );
    const created = await orpc.visions.create({ name });
    if (!created) return;
    setVisions((vs) => [
      ...vs,
      { ...created, expanded: true },
    ]);
    startEdit({ type: "vision", id: created.id }, created.name);
  }

  async function createStrategicIntent(visionId: number) {
    const siNames = strategicIntents.map((si) => si.name);
    const name = nextAvailableGeneratedName("Strategic Intent", siNames);
    const created = await orpc.strategicIntents.create({ visionId, name });
    if (!created) return;
    setStrategicIntents((sis) => [
      ...sis,
      { ...created, expanded: true },
    ]);
    setVisions((vs) =>
      vs.map((v) => (v.id === visionId ? { ...v, expanded: true } : v)),
    );
    startEdit({ type: "si", id: created.id }, created.name);
  }

  async function createInitiativeUnderSI(siId: number) {
    const name = nextAvailableGeneratedName(
      "Initiative",
      initiatives.map((i) => i.name),
    );
    const created = await orpc.initiatives.create({ name });
    if (!created) return;
    await orpc.initiatives.setStrategicIntent({
      id: created.id,
      strategicIntentId: siId,
    });
    const newInit: Initiative = {
      id: created.id,
      name: created.name,
      description: created.description ?? null,
      strategicIntentId: siId,
      position: created.position,
      expanded: false,
    };
    setInitiatives((inits) => [...inits, newInit]);
    setStrategicIntents((sis) =>
      sis.map((si) => (si.id === siId ? { ...si, expanded: true } : si)),
    );
    startEdit({ type: "initiative", id: created.id }, created.name);
  }

  // ── Move initiative ───────────────────────────────────────────────────────

  function openMoveDialog(initiative: Initiative) {
    setMoveDialog({
      id: initiative.id,
      name: initiative.name,
      currentSiId: initiative.strategicIntentId,
      targetSiId: initiative.strategicIntentId,
    });
    setMenuNode(null);
  }

  async function confirmMoveInitiative() {
    if (!moveDialog) return;
    try {
      await orpc.initiatives.setStrategicIntent({
        id: moveDialog.id,
        strategicIntentId: moveDialog.targetSiId,
      });
      setInitiatives((inits) =>
        inits.map((i) =>
          i.id === moveDialog.id
            ? { ...i, strategicIntentId: moveDialog.targetSiId }
            : i,
        ),
      );
      setMoveDialog(null);
    } catch {
      alert("移動できませんでした。");
    }
  }

  // ── Expand/Collapse ───────────────────────────────────────────────────────

  function toggleVision(id: number) {
    setVisions((vs) =>
      vs.map((v) => (v.id === id ? { ...v, expanded: !v.expanded } : v)),
    );
  }

  function toggleSI(id: number) {
    setStrategicIntents((sis) =>
      sis.map((si) =>
        si.id === id ? { ...si, expanded: !si.expanded } : si,
      ),
    );
  }

  function toggleInitiative(id: number) {
    setInitiatives((inits) =>
      inits.map((i) =>
        i.id === id ? { ...i, expanded: !i.expanded } : i,
      ),
    );
  }

  // ── Drag & Drop ───────────────────────────────────────────────────────────

  function handleDragStart(item: DragItem) {
    setDragItem(item);
  }

  function handleDragEnd() {
    setDragItem(null);
    setDropTargetId(null);
  }

  function handleDragOver(
    e: React.DragEvent,
    targetId: number,
    targetType: string,
  ) {
    if (!dragItem || dragItem.type !== targetType) return;
    if (dragItem.type === "si") {
      const draggedSI = strategicIntents.find((si) => si.id === dragItem.id);
      const targetSI = strategicIntents.find((si) => si.id === targetId);
      if (draggedSI?.visionId !== targetSI?.visionId) return;
    }
    e.preventDefault();
    setDropTargetId(targetId);
  }

  async function handleDrop(e: React.DragEvent, targetId: number) {
    e.preventDefault();
    if (!dragItem) return;
    const id = dragItem.id;
    if (id === targetId) {
      setDragItem(null);
      setDropTargetId(null);
      return;
    }
    try {
      if (dragItem.type === "vision") {
        const updated = await orpc.visions.move({ id, beforeId: targetId });
        const expandMap = new Map(visions.map((v) => [v.id, v.expanded]));
        setVisions(updated.map((v) => ({ ...v, expanded: expandMap.get(v.id) ?? true })));
      } else if (dragItem.type === "si") {
        const updated = await orpc.strategicIntents.move({
          id,
          beforeId: targetId,
        });
        const expandMap = new Map(strategicIntents.map((si) => [si.id, si.expanded]));
        setStrategicIntents(updated.map((si) => ({ ...si, expanded: expandMap.get(si.id) ?? true })));
      } else {
        const updated = await orpc.initiatives.move({ id, beforeId: targetId });
        const expandMap = new Map(initiatives.map((i) => [i.id, i.expanded]));
        setInitiatives(
          updated.map((init) => ({
            id: init.id,
            name: init.name,
            description: init.description ?? null,
            strategicIntentId: init.strategicIntentId ?? null,
            position: init.position,
            expanded: expandMap.get(init.id) ?? false,
          })),
        );
      }
    } catch {
      /* ignore */
    } finally {
      setDragItem(null);
      setDropTargetId(null);
    }
  }

  // ── Close menu on outside click ───────────────────────────────────────────

  useEffect(() => {
    if (!menuNode) return;
    const handler = () => setMenuNode(null);
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [menuNode]);

  // ── Render ────────────────────────────────────────────────────────────────

  const unclassifiedInitiatives = initiatives.filter(
    (i) => i.strategicIntentId === null,
  );

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
              className="cv-nav-link"
              onClick={() => navigate("/members")}
            >
              Members
            </button>
            <button type="button" className="cv-nav-link active">
              Strategy
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
            Epics
          </button>
          <button
            type="button"
            className="cv-nav-link"
            onClick={() => navigate("/members")}
          >
            Members
          </button>
          <button type="button" className="cv-nav-link active">
            Strategy
          </button>
        </nav>
      </header>

      <div className="st-tree">
        {/* Vision list */}
        {visions.map((vision) => {
          const visionSIs = strategicIntents.filter(
            (si) => si.visionId === vision.id,
          );
          const isVisionDragOver = dropTargetId === vision.id && dragItem?.type === "vision";

          return (
            <div key={vision.id} className={`st-vision-block${isVisionDragOver ? " st-drag-over" : ""}`}>
              {/* Vision row */}
              {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop target */}
              <div
                className="st-node st-layer-vision"
                onDragOver={(e) => handleDragOver(e, vision.id, "vision")}
                onDrop={(e) => void handleDrop(e, vision.id)}
              >
                <button
                  type="button"
                  className="st-grip"
                  draggable
                  onDragStart={() => handleDragStart({ type: "vision", id: vision.id })}
                  onDragEnd={handleDragEnd}
                  title="ドラッグして並び替え"
                  aria-label="ドラッグして並び替え"
                >
                  <GripVertical size={14} />
                </button>
                <button
                  type="button"
                  className="st-chevron"
                  onClick={() => toggleVision(vision.id)}
                  title={vision.expanded ? "折りたたむ" : "展開する"}
                >
                  {vision.expanded ? (
                    <ChevronDown size={14} />
                  ) : (
                    <ChevronRight size={14} />
                  )}
                </button>
                <span className="st-layer-badge st-badge-vision">Vision</span>
                {editingNode?.type === "vision" &&
                editingNode.id === vision.id ? (
                  <div className="st-inline-edit">
                    <input
                      ref={editingInputRef}
                      className="st-name-input"
                      value={editingName}
                      onChange={(e) => {
                        setEditingName(e.target.value);
                        setEditingError(null);
                      }}
                      onBlur={() => void commitEdit()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void commitEdit();
                        if (e.key === "Escape") cancelEdit();
                      }}
                      // biome-ignore lint/a11y/noAutofocus: intentional focus for inline editing
                      autoFocus
                    />
                    {editingError && (
                      <span className="st-error">{editingError}</span>
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    className="st-name-btn"
                    onClick={() =>
                      startEdit({ type: "vision", id: vision.id }, vision.name)
                    }
                  >
                    {vision.name}
                  </button>
                )}
                {vision.description && (
                  <span className="st-desc-preview" title={vision.description}>
                    {vision.description.slice(0, 60)}
                    {vision.description.length > 60 ? "…" : ""}
                  </span>
                )}
                <div className="st-node-actions">
                  <button
                    type="button"
                    className="st-action-btn"
                    title="Strategic Intentを追加"
                    onClick={() => void createStrategicIntent(vision.id)}
                  >
                    <Plus size={13} />
                  </button>
                  <div className="st-menu-wrap">
                    <button
                      type="button"
                      className="st-action-btn"
                      title="メニュー"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuNode(
                          menuNode?.id === vision.id &&
                            menuNode?.type === "vision"
                            ? null
                            : { type: "vision", id: vision.id },
                        );
                      }}
                    >
                      <MoreHorizontal size={13} />
                    </button>
                    {menuNode?.type === "vision" &&
                      menuNode.id === vision.id && (
                        <div
                          role="menu"
                          className="st-menu"
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            onClick={() =>
                              openDescDialog(
                                "vision",
                                vision.id,
                                vision.name,
                                vision.description,
                              )
                            }
                          >
                            説明を編集
                          </button>
                          <button
                            type="button"
                            className="st-menu-danger"
                            onClick={() =>
                              openDeleteDialog("vision", vision.id, vision.name)
                            }
                          >
                            削除
                          </button>
                        </div>
                      )}
                  </div>
                </div>
              </div>

              {/* Strategic Intents */}
              {vision.expanded && (
                <div className="st-si-list">
                  {visionSIs.map((si) => {
                    const siInitiatives = initiatives.filter(
                      (i) => i.strategicIntentId === si.id,
                    );
                    const isSIDragOver =
                      dropTargetId === si.id && dragItem?.type === "si";

                    return (
                      <div key={si.id} className={`st-si-block${isSIDragOver ? " st-drag-over" : ""}`}>
                        {/* Strategic Intent row */}
                        {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop target */}
                        <div
                          className="st-node st-layer-si"
                          onDragOver={(e) => handleDragOver(e, si.id, "si")}
                          onDrop={(e) => void handleDrop(e, si.id)}
                        >
                          <button
                            type="button"
                            className="st-grip"
                            draggable
                            onDragStart={() =>
                              handleDragStart({
                                type: "si",
                                id: si.id,
                                visionId: si.visionId,
                              })
                            }
                            onDragEnd={handleDragEnd}
                            title="ドラッグして並び替え"
                            aria-label="ドラッグして並び替え"
                          >
                            <GripVertical size={14} />
                          </button>
                          <button
                            type="button"
                            className="st-chevron"
                            onClick={() => toggleSI(si.id)}
                          >
                            {si.expanded ? (
                              <ChevronDown size={14} />
                            ) : (
                              <ChevronRight size={14} />
                            )}
                          </button>
                          <span className="st-layer-badge st-badge-si">
                            SI
                          </span>
                          {editingNode?.type === "si" &&
                          editingNode.id === si.id ? (
                            <div className="st-inline-edit">
                              <input
                                ref={editingInputRef}
                                className="st-name-input"
                                value={editingName}
                                onChange={(e) => {
                                  setEditingName(e.target.value);
                                  setEditingError(null);
                                }}
                                onBlur={() => void commitEdit()}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") void commitEdit();
                                  if (e.key === "Escape") cancelEdit();
                                }}
                                // biome-ignore lint/a11y/noAutofocus: intentional focus for inline editing
                      autoFocus
                              />
                              {editingError && (
                                <span className="st-error">
                                  {editingError}
                                </span>
                              )}
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="st-name-btn"
                              onClick={() =>
                                startEdit({ type: "si", id: si.id }, si.name)
                              }
                            >
                              {si.name}
                            </button>
                          )}
                          {si.description && (
                            <span
                              className="st-desc-preview"
                              title={si.description}
                            >
                              {si.description.slice(0, 60)}
                              {si.description.length > 60 ? "…" : ""}
                            </span>
                          )}
                          <div className="st-node-actions">
                            <button
                              type="button"
                              className="st-action-btn"
                              title="Initiativeを追加"
                              onClick={() =>
                                void createInitiativeUnderSI(si.id)
                              }
                            >
                              <Plus size={13} />
                            </button>
                            <div className="st-menu-wrap">
                              <button
                                type="button"
                                className="st-action-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setMenuNode(
                                    menuNode?.id === si.id &&
                                      menuNode?.type === "si"
                                      ? null
                                      : { type: "si", id: si.id },
                                  );
                                }}
                              >
                                <MoreHorizontal size={13} />
                              </button>
                              {menuNode?.type === "si" &&
                                menuNode.id === si.id && (
                                  <div
                                    role="menu"
                                    className="st-menu"
                                    onClick={(e) => e.stopPropagation()}
                                    onKeyDown={(e) => e.stopPropagation()}
                                  >
                                    <button
                                      type="button"
                                      onClick={() =>
                                        openDescDialog(
                                          "si",
                                          si.id,
                                          si.name,
                                          si.description,
                                        )
                                      }
                                    >
                                      説明を編集
                                    </button>
                                    <button
                                      type="button"
                                      className="st-menu-danger"
                                      onClick={() =>
                                        openDeleteDialog("si", si.id, si.name)
                                      }
                                    >
                                      削除
                                    </button>
                                  </div>
                                )}
                            </div>
                          </div>
                        </div>

                        {/* Initiatives under SI */}
                        {si.expanded && (
                          <div className="st-init-list">
                            {siInitiatives.map((init) => {
                              const initEpics = epics.filter(
                                (e) => e.initiativeId === init.id,
                              );
                              const isInitDragOver =
                                dropTargetId === init.id &&
                                dragItem?.type === "initiative";

                              return (
                                <div
                                  key={init.id}
                                  className={`st-init-block${isInitDragOver ? " st-drag-over" : ""}`}
                                >
                                  {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop target */}
                                  <div
                                    className="st-node st-layer-initiative"
                                    onDragOver={(e) =>
                                      handleDragOver(e, init.id, "initiative")
                                    }
                                    onDrop={(e) =>
                                      void handleDrop(e, init.id)
                                    }
                                  >
                                    <button
                                      type="button"
                                      className="st-grip"
                                      draggable
                                      onDragStart={() =>
                                        handleDragStart({
                                          type: "initiative",
                                          id: init.id,
                                          strategicIntentId:
                                            init.strategicIntentId,
                                        })
                                      }
                                      onDragEnd={handleDragEnd}
                                      aria-label="ドラッグして並び替え"
                                    >
                                      <GripVertical size={14} />
                                    </button>
                                    {initEpics.length > 0 ? (
                                      <button
                                        type="button"
                                        className="st-chevron"
                                        onClick={() =>
                                          toggleInitiative(init.id)
                                        }
                                      >
                                        {init.expanded ? (
                                          <ChevronDown size={14} />
                                        ) : (
                                          <ChevronRight size={14} />
                                        )}
                                      </button>
                                    ) : (
                                      <span className="st-chevron-placeholder" />
                                    )}
                                    <span className="st-layer-badge st-badge-initiative">
                                      Initiative
                                    </span>
                                    {editingNode?.type === "initiative" &&
                                    editingNode.id === init.id ? (
                                      <div className="st-inline-edit">
                                        <input
                                          ref={editingInputRef}
                                          className="st-name-input"
                                          value={editingName}
                                          onChange={(e) => {
                                            setEditingName(e.target.value);
                                            setEditingError(null);
                                          }}
                                          onBlur={() => void commitEdit()}
                                          onKeyDown={(e) => {
                                            if (e.key === "Enter")
                                              void commitEdit();
                                            if (e.key === "Escape")
                                              cancelEdit();
                                          }}
                                          // biome-ignore lint/a11y/noAutofocus: intentional focus for inline editing
                      autoFocus
                                        />
                                        {editingError && (
                                          <span className="st-error">
                                            {editingError}
                                          </span>
                                        )}
                                      </div>
                                    ) : (
                                      <button
                                        type="button"
                                        className="st-name-btn"
                                        onClick={() =>
                                          startEdit(
                                            {
                                              type: "initiative",
                                              id: init.id,
                                            },
                                            init.name,
                                          )
                                        }
                                      >
                                        {init.name}
                                      </button>
                                    )}
                                    {init.description && (
                                      <span
                                        className="st-desc-preview"
                                        title={init.description}
                                      >
                                        {init.description.slice(0, 60)}
                                        {init.description.length > 60
                                          ? "…"
                                          : ""}
                                      </span>
                                    )}
                                    <div className="st-node-actions">
                                      <div className="st-menu-wrap">
                                        <button
                                          type="button"
                                          className="st-action-btn"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setMenuNode(
                                              menuNode?.id === init.id &&
                                                menuNode?.type === "initiative"
                                                ? null
                                                : {
                                                    type: "initiative",
                                                    id: init.id,
                                                  },
                                            );
                                          }}
                                        >
                                          <MoreHorizontal size={13} />
                                        </button>
                                        {menuNode?.type === "initiative" &&
                                          menuNode.id === init.id && (
                                            <div
                                              role="menu"
                                              className="st-menu"
                                              onClick={(e) =>
                                                e.stopPropagation()
                                              }
                                              onKeyDown={(e) =>
                                                e.stopPropagation()
                                              }
                                            >
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  openDescDialog(
                                                    "initiative",
                                                    init.id,
                                                    init.name,
                                                    init.description,
                                                  )
                                                }
                                              >
                                                説明を編集
                                              </button>
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  openMoveDialog(init)
                                                }
                                              >
                                                移動…
                                              </button>
                                              <button
                                                type="button"
                                                className="st-menu-danger"
                                                onClick={() =>
                                                  openDeleteDialog(
                                                    "initiative",
                                                    init.id,
                                                    init.name,
                                                  )
                                                }
                                              >
                                                削除
                                              </button>
                                            </div>
                                          )}
                                      </div>
                                    </div>
                                  </div>

                                  {/* Epics under initiative */}
                                  {init.expanded && initEpics.length > 0 && (
                                    <div className="st-epic-list">
                                      {initEpics.map((epic) => (
                                        <div
                                          key={epic.id}
                                          className="st-node st-layer-epic"
                                        >
                                          <span className="st-epic-bullet">
                                            ·
                                          </span>
                                          <span className="st-layer-badge st-badge-epic">
                                            Epic
                                          </span>
                                          <span className="st-epic-name">
                                            {epic.name}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })}

                            {/* Add initiative button */}
                            <button
                              type="button"
                              className="st-add-child-btn"
                              onClick={() => void createInitiativeUnderSI(si.id)}
                            >
                              <Plus size={12} />
                              Initiative を追加
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Add Strategic Intent button */}
                  <button
                    type="button"
                    className="st-add-child-btn st-add-si-btn"
                    onClick={() => void createStrategicIntent(vision.id)}
                  >
                    <Plus size={12} />
                    Strategic Intent を追加
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {/* Add Vision button */}
        <button
          type="button"
          className="st-add-vision-btn"
          onClick={() => void createVision()}
        >
          <Plus size={14} />
          Vision を追加
        </button>

        {/* Unclassified Initiatives */}
        {unclassifiedInitiatives.length > 0 && (
          <div className="st-unclassified">
            <div className="st-unclassified-header">未分類 Initiatives</div>
            {unclassifiedInitiatives.map((init) => {
              const initEpics = epics.filter(
                (e) => e.initiativeId === init.id,
              );
              const isInitDragOver =
                dropTargetId === init.id && dragItem?.type === "initiative";

              return (
                <div
                  key={init.id}
                  className={`st-init-block${isInitDragOver ? " st-drag-over" : ""}`}
                >
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop target */}
                  <div
                    className="st-node st-layer-initiative"
                    onDragOver={(e) =>
                      handleDragOver(e, init.id, "initiative")
                    }
                    onDrop={(e) => void handleDrop(e, init.id)}
                  >
                    <button
                      type="button"
                      className="st-grip"
                      draggable
                      onDragStart={() =>
                        handleDragStart({
                          type: "initiative",
                          id: init.id,
                          strategicIntentId: null,
                        })
                      }
                      onDragEnd={handleDragEnd}
                      aria-label="ドラッグして並び替え"
                    >
                      <GripVertical size={14} />
                    </button>
                    {initEpics.length > 0 ? (
                      <button
                        type="button"
                        className="st-chevron"
                        onClick={() => toggleInitiative(init.id)}
                      >
                        {init.expanded ? (
                          <ChevronDown size={14} />
                        ) : (
                          <ChevronRight size={14} />
                        )}
                      </button>
                    ) : (
                      <span className="st-chevron-placeholder" />
                    )}
                    <span className="st-layer-badge st-badge-initiative">
                      Initiative
                    </span>
                    {editingNode?.type === "initiative" &&
                    editingNode.id === init.id ? (
                      <div className="st-inline-edit">
                        <input
                          ref={editingInputRef}
                          className="st-name-input"
                          value={editingName}
                          onChange={(e) => {
                            setEditingName(e.target.value);
                            setEditingError(null);
                          }}
                          onBlur={() => void commitEdit()}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void commitEdit();
                            if (e.key === "Escape") cancelEdit();
                          }}
                          // biome-ignore lint/a11y/noAutofocus: intentional focus for inline editing
                      autoFocus
                        />
                        {editingError && (
                          <span className="st-error">{editingError}</span>
                        )}
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="st-name-btn"
                        onClick={() =>
                          startEdit(
                            { type: "initiative", id: init.id },
                            init.name,
                          )
                        }
                      >
                        {init.name}
                      </button>
                    )}
                    {init.description && (
                      <span
                        className="st-desc-preview"
                        title={init.description}
                      >
                        {init.description.slice(0, 60)}
                        {init.description.length > 60 ? "…" : ""}
                      </span>
                    )}
                    <div className="st-node-actions">
                      <div className="st-menu-wrap">
                        <button
                          type="button"
                          className="st-action-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuNode(
                              menuNode?.id === init.id &&
                                menuNode?.type === "initiative"
                                ? null
                                : { type: "initiative", id: init.id },
                            );
                          }}
                        >
                          <MoreHorizontal size={13} />
                        </button>
                        {menuNode?.type === "initiative" &&
                          menuNode.id === init.id && (
                            <div
                              role="menu"
                              className="st-menu"
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => e.stopPropagation()}
                            >
                              <button
                                type="button"
                                onClick={() =>
                                  openDescDialog(
                                    "initiative",
                                    init.id,
                                    init.name,
                                    init.description,
                                  )
                                }
                              >
                                説明を編集
                              </button>
                              <button
                                type="button"
                                onClick={() => openMoveDialog(init)}
                              >
                                移動…
                              </button>
                              <button
                                type="button"
                                className="st-menu-danger"
                                onClick={() =>
                                  openDeleteDialog(
                                    "initiative",
                                    init.id,
                                    init.name,
                                  )
                                }
                              >
                                削除
                              </button>
                            </div>
                          )}
                      </div>
                    </div>
                  </div>
                  {init.expanded && initEpics.length > 0 && (
                    <div className="st-epic-list">
                      {initEpics.map((epic) => (
                        <div
                          key={epic.id}
                          className="st-node st-layer-epic"
                        >
                          <span className="st-epic-bullet">·</span>
                          <span className="st-layer-badge st-badge-epic">
                            Epic
                          </span>
                          <span className="st-epic-name">{epic.name}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Description dialog */}
      {descDialog && (
        // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop closes on click; keyboard handled by dialog via Escape
        // biome-ignore lint/a11y/useKeyWithClickEvents: modal backdrop closes on click; keyboard handled by dialog via Escape
        <div
          className="confirm-overlay"
          onClick={() => setDescDialog(null)}
        >
          <div
            className="confirm-dialog st-desc-dialog"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setDescDialog(null);
            }}
          >
            <button
              type="button"
              className="st-dialog-close"
              onClick={() => setDescDialog(null)}
            >
              <X size={16} />
            </button>
            <h2 className="st-dialog-title">{descDialog.name}</h2>
            <p className="st-dialog-label">説明</p>
            <textarea
              className="st-desc-textarea"
              value={descDialog.value}
              onChange={(e) =>
                setDescDialog((d) =>
                  d ? { ...d, value: e.target.value } : d,
                )
              }
              placeholder="説明を入力（任意）"
              rows={6}
            />
            <div className="confirm-btns">
              <button
                type="button"
                className="confirm-cancel"
                onClick={() => setDescDialog(null)}
              >
                キャンセル
              </button>
              <button
                type="button"
                className="confirm-ok"
                onClick={() => void saveDesc()}
                disabled={descSaving}
              >
                {descSaving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete dialog */}
      {deleteDialog && (
        // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop closes on click; keyboard handled by dialog via Escape
        // biome-ignore lint/a11y/useKeyWithClickEvents: modal backdrop closes on click; keyboard handled by dialog via Escape
        <div
          className="confirm-overlay"
          onClick={() => setDeleteDialog(null)}
        >
          <div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setDeleteDialog(null);
            }}
          >
            <p className="confirm-message">
              「{deleteDialog.name}」を削除しますか？
            </p>
            {deleteDialog.warning && (
              <p className="st-dialog-warning">{deleteDialog.warning}</p>
            )}
            <div className="confirm-btns">
              <button
                type="button"
                className="confirm-cancel"
                onClick={() => setDeleteDialog(null)}
              >
                キャンセル
              </button>
              <button
                type="button"
                className="confirm-ok confirm-ok-danger"
                onClick={() => void confirmDelete()}
                disabled={deleting}
              >
                {deleting ? "削除中…" : "削除"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Move initiative dialog */}
      {moveDialog && (
        // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop closes on click; keyboard handled by dialog via Escape
        // biome-ignore lint/a11y/useKeyWithClickEvents: modal backdrop closes on click; keyboard handled by dialog via Escape
        <div
          className="confirm-overlay"
          onClick={() => setMoveDialog(null)}
        >
          <div
            className="confirm-dialog st-move-dialog"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setMoveDialog(null);
            }}
          >
            <button
              type="button"
              className="st-dialog-close"
              onClick={() => setMoveDialog(null)}
            >
              <X size={16} />
            </button>
            <h2 className="st-dialog-title">
              「{moveDialog.name}」を移動
            </h2>
            <p className="st-dialog-label">移動先 Strategic Intent</p>
            <select
              className="st-move-select"
              value={moveDialog.targetSiId ?? ""}
              onChange={(e) => {
                const val = e.target.value;
                setMoveDialog((d) =>
                  d
                    ? {
                        ...d,
                        targetSiId: val === "" ? null : Number(val),
                      }
                    : d,
                );
              }}
            >
              <option value="">未分類</option>
              {visions.map((v) => {
                const vSIs = strategicIntents.filter(
                  (si) => si.visionId === v.id,
                );
                if (vSIs.length === 0) return null;
                return (
                  <optgroup key={v.id} label={v.name}>
                    {vSIs.map((si) => (
                      <option key={si.id} value={si.id}>
                        {si.name}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
            <div className="confirm-btns">
              <button
                type="button"
                className="confirm-cancel"
                onClick={() => setMoveDialog(null)}
              >
                キャンセル
              </button>
              <button
                type="button"
                className="confirm-ok"
                onClick={() => void confirmMoveInitiative()}
                disabled={moveDialog.targetSiId === moveDialog.currentSiId}
              >
                移動
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
