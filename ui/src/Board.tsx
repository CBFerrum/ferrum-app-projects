// The board: a column for each status, cards in manual order, and everything done to a task from
// where it stands. A card can be dragged to another column or to another place in its own (with the
// mouse or a finger), moved with the keyboard (Shift and the arrow keys), or sent anywhere from its
// menu. A move shows at once and goes back, with the server's reason, if the server refuses it; the
// server holds the rules (what may start, what may close). Swimlanes, the order and the filters live
// in the address, so a link to a board is a link to the view.

import {
  closestCenter,
  DndContext,
  DragOverlay,
  MouseSensor,
  pointerWithin,
  rectIntersection,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { type CSSProperties, type FormEvent, type HTMLAttributes, type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { todayIso } from "@ferrum/client";
import { Alert, Badge, Button, confirmDialog, EmptyState, statusTone, toast, useDebounced } from "@ferrum/kit";
import { can, useMe, useMetaIndex } from "@ferrum/records";
import { Avatar, Keys } from "./bits";
import {
  boardModel,
  type Card,
  dropAllowed,
  dropPlan,
  filterParams,
  filtersOn,
  type Filters,
  focusMove,
  keyMove,
  type Lanes,
  type Move,
  NO_FILTERS,
  NOBODY,
  type Order,
  readFilters,
  readLanes,
  readOrder,
  type Way,
} from "./kanban";
import { CardMenu, type CardActions, CardView, SortableCard } from "./Card";
import { changeTask, createTask, type Project, TASK_LIMIT, type TaskSet, useNames, useQueryState } from "./data";
import { assignees, blockers, PRIORITIES, subtaskCounts, type Task } from "./plan";

/** Where each card and each column stands in a layout: a card to the column that holds it, a column to itself. */
function whereIs(items: Record<string, string[]>): Map<string, string> {
  const at = new Map<string, string>();
  for (const [cell, keys] of Object.entries(items)) {
    at.set(cell, cell);
    for (const k of keys) at.set(k, cell);
  }
  return at;
}

const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ── the bar above the board ──

function Bar({ filters, lanes, order, people, parents, names, set, shown, total }: {
  filters: Filters;
  lanes: Lanes;
  order: Order;
  people: string[];
  parents: Task[];
  names: (email: string) => string;
  set: (change: Record<string, string | null>) => void;
  shown: number;
  total: number;
}) {
  const [text, setText] = useState(filters.q);
  const typed = useDebounced(text, 200);
  // The address is only written when the person stops typing.
  useEffect(() => {
    if (typed !== filters.q) set({ q: typed || null });
  }, [typed]);
  const change = (patch: Partial<Filters>) => set(filterParams({ ...filters, ...patch }));
  const on = filtersOn(filters) + (filters.q ? 1 : 0);
  return (
    <div className="pj-tools" role="search" aria-label="Filter the board">
      <input className="input pj-search" type="search" placeholder="Find a task…" aria-label="Find a task" value={text} onChange={(e) => setText(e.target.value)} />
      <select className="select pj-select" aria-label="Assignee" value={filters.who} onChange={(e) => change({ who: e.target.value })}>
        <option value="">Anyone</option>
        <option value="me">Me</option>
        <option value="none">Nobody</option>
        {people.map((p) => (
          <option key={p} value={p}>
            {names(p)}
          </option>
        ))}
      </select>
      <select className="select pj-select" aria-label="Priority" value={filters.priority} onChange={(e) => change({ priority: e.target.value })}>
        <option value="">Any priority</option>
        {PRIORITIES.map((p) => (
          <option key={p}>{p}</option>
        ))}
      </select>
      <select className="select pj-select" aria-label="Due" value={filters.due} onChange={(e) => change({ due: e.target.value as Filters["due"] })}>
        <option value="">Any due date</option>
        <option value="late">Late</option>
        <option value="week">Due this week</option>
        <option value="none">No due date</option>
      </select>
      <select className="select pj-select" aria-label="Sub-tasks" value={filters.parent} onChange={(e) => change({ parent: e.target.value })}>
        <option value="">All tasks</option>
        <option value="top">Hide sub-tasks</option>
        {parents.map((p) => (
          <option key={p.id} value={p.id}>
            Under {p.number} {p.subject}
          </option>
        ))}
      </select>
      <span className="pj-tools-gap" />
      <label className="pj-tools-pick">
        <span className="faint">Swimlanes</span>
        <select className="select pj-select" value={lanes} onChange={(e) => set({ lanes: e.target.value === "none" ? null : e.target.value })}>
          <option value="none">None</option>
          <option value="assignee">Person</option>
          <option value="priority">Priority</option>
        </select>
      </label>
      <label className="pj-tools-pick">
        <span className="faint">Order</span>
        <select className="select pj-select" value={order} onChange={(e) => set({ order: e.target.value === "manual" ? null : e.target.value })}>
          <option value="manual">Manual</option>
          <option value="due">Due soonest</option>
          <option value="priority">Priority</option>
        </select>
      </label>
      <Keys
        keys={[
          ["Enter", "Open the task"],
          ["↑ ↓ ← → or J K", "Go to another card"],
          ["Shift + ← →", "Move the card to the next column"],
          ["Shift + ↑ ↓", "Move it up or down its column"],
          ["Esc", "Close the panel"],
        ]}
      />
      <p className="pj-tools-count faint" aria-live="polite">
        {shown === total ? `${total} ${total === 1 ? "task" : "tasks"}` : `${shown} of ${total} tasks`}
        {on > 0 && (
          <>
            {" · "}
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setText("");
                set(filterParams(NO_FILTERS));
              }}
            >
              Clear {on === 1 ? "the filter" : "filters"}
            </button>
          </>
        )}
      </p>
    </div>
  );
}

// ── a column's head and its adder ──

function Adder({ status, onCreate, onClose }: { status: string; onCreate: (subject: string) => Promise<boolean>; onClose: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const subject = text.trim();
    if (!subject) return;
    setBusy(true);
    // Enter adds and stays open, so a list of tasks goes in one after another.
    if (await onCreate(subject)) setText("");
    setBusy(false);
  };
  return (
    <form className="pj-adder" onSubmit={(e) => void submit(e)}>
      <input
        autoFocus
        className="input"
        aria-label={`New task in ${status}`}
        placeholder="Title, then Enter"
        value={text}
        readOnly={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        onBlur={() => !text.trim() && onClose()}
      />
    </form>
  );
}

// ── a cell: one status of one lane ──

function Cell({ id, status, keys, cards, over, sortNote, canDrag, render }: {
  id: string;
  status: string;
  keys: string[];
  cards: Map<string, Card>;
  over: boolean;
  sortNote: string | null;
  canDrag: boolean;
  render: (card: Card, props: HTMLAttributes<HTMLElement>, held: boolean) => ReactNode;
}) {
  const { setNodeRef } = useDroppable({ id, disabled: status === "Overdue" });
  return (
    <div ref={setNodeRef} className="pj-cell" data-over={over || undefined} data-status={status} role="group" aria-label={`${status}, ${keys.length} ${keys.length === 1 ? "task" : "tasks"}`}>
      <SortableContext id={id} items={keys} strategy={verticalListSortingStrategy}>
        <ul className="pj-cards">
          {keys.map((k) => {
            const card = cards.get(k);
            return (
              card && (
                <SortableCard key={k} id={k} disabled={!canDrag}>
                  {(props, held) => render(card, props, held)}
                </SortableCard>
              )
            );
          })}
        </ul>
      </SortableContext>
      {over && sortNote && <p className="pj-sort-note">{sortNote}</p>}
    </div>
  );
}

// ── the board ──

export function Board({ project, set: tasks, open, onOpen }: { project: Project; set: TaskSet; open: string | null; onOpen: (id: string | null) => void }) {
  const qc = useQueryClient();
  const me = useMe().data?.user.email ?? "";
  const meta = useMetaIndex().data?.entities.find((e) => e.name === "Task");
  const names = useNames();
  const [sp, setQuery] = useQueryState();
  const filters = readFilters(sp);
  const lanes = readLanes(sp);
  const order = readOrder(sp);
  const today = todayIso();
  const closed = project.status === "Completed" || project.status === "Cancelled";
  const canWrite = !!meta && can(meta.permissions, "write") && !closed;
  const canCreate = !!meta && can(meta.permissions, "create") && !closed;

  const model = useMemo(() => boardModel(tasks.rows, filters, lanes, order, { me, today }), [tasks.rows, sp.toString(), me, today]);
  const byId = useMemo(() => new Map(tasks.rows.map((t) => [t.id, t])), [tasks.rows]);
  const counts = useMemo(() => subtaskCounts(tasks.rows), [tasks.rows]);
  const cards = useMemo(() => new Map(model.lanes.flatMap((l) => l.cells.flatMap((c) => c.cards)).map((c) => [c.key, c])), [model]);
  const base = useMemo(() => Object.fromEntries(model.lanes.flatMap((l) => l.cells.map((c) => [c.id, c.cards.map((x) => x.key)]))), [model]);
  const people = useMemo(() => [...new Set(tasks.rows.flatMap((t) => assignees(t).map((a) => a.toLowerCase())))].sort((a, b) => names(a).localeCompare(names(b))), [tasks.rows, names]);
  const parents = useMemo(() => tasks.rows.filter((t) => counts.has(t.id)), [tasks.rows, counts]);

  const [adding, setAdding] = useState<string | null>(null);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  // During a drag: where every card stands now, as the person has carried it. Otherwise null.
  const [live, setLive] = useState<Record<string, string[]> | null>(null);
  const [held, setHeld] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const items = live ?? base;
  const where = useMemo(() => whereIs(items), [items]);
  const cellOf = useMemo(() => new Map(model.lanes.flatMap((l) => l.cells.flatMap((c) => c.cards.map((k) => [k.key, c] as const)))), [model]);
  const cellById = useMemo(() => new Map(model.lanes.flatMap((l) => l.cells.map((c) => [c.id, c] as const))), [model]);
  const refocus = useRef<string | null>(null);
  const lastOver = useRef<string | null>(null);

  // Keyboard moves re-draw the card elsewhere: put focus back on it.
  useEffect(() => {
    if (!refocus.current) return;
    const el = document.querySelector<HTMLElement>(`[data-card-key="${CSS.escape(refocus.current)}"]`);
    refocus.current = null;
    el?.focus();
  }, [model]);

  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }));

  const cardData = useCallback(
    (task: Task) => ({ task, names, today, blockedBy: blockers(task, byId), subtasks: counts.get(task.id) }),
    [names, today, byId, counts],
  );

  // ── doing things to a task ──

  const apply = (card: Card, move: Move, said: string) => {
    setNote(said);
    void changeTask(qc, project.id, card.task, move.patch as Partial<Task>);
    // Other cards that had to be ranked again follow quietly; a refusal there only reloads.
    for (const o of move.also) {
      const other = byId.get(o.id);
      if (other) void changeTask(qc, project.id, other, { rank: o.rank }, true);
    }
  };

  const said = (card: Card, move: Move, to: string, at: number) => {
    const cell = model.lanes.flatMap((l) => l.cells).find((c) => c.id === to);
    const n = (cell?.cards.filter((c) => c.task.id !== card.task.id).length ?? 0) + 1;
    return `Moved ${card.task.subject ?? "the task"}${move.patch.status ? ` to ${move.patch.status}` : ""}, position ${at + 1} of ${n}.`;
  };

  const drop = (key: string, to: string, at: number) => {
    const card = cards.get(key);
    const move = card && dropPlan(model, key, to, at, lanes, order);
    if (card && move) apply(card, move, said(card, move, to, at));
  };

  const byKey = (e: KeyboardEvent<HTMLElement>, card: Card) => {
    // Keys pressed in the card's menu are the menu's.
    if (e.target !== e.currentTarget) return;
    const way: Way | undefined = ({ ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" } as Record<string, Way>)[e.key];
    const focus = (key: string | null) => {
      if (key) document.querySelector<HTMLElement>(`[data-card-key="${CSS.escape(key)}"]`)?.focus();
    };
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(card.task.id);
    } else if (e.key === "Escape" && open) {
      onOpen(null);
    } else if (way && e.shiftKey) {
      e.preventDefault();
      if (!canWrite) return;
      const to = keyMove(model, card.key, way, order);
      if (!to) {
        if (order !== "manual" && (way === "up" || way === "down")) toast("The cards are ordered by a sort. Choose Manual order to move them up and down.", "info");
        return;
      }
      const move = dropPlan(model, card.key, to.to, to.at, lanes, order);
      if (move) {
        refocus.current = card.key;
        apply(card, move, said(card, move, to.to, to.at));
      }
    } else if (way) {
      e.preventDefault();
      focus(focusMove(model, card.key, way));
    } else if ((e.key === "j" || e.key === "k") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      focus(focusMove(model, card.key, e.key === "j" ? "next" : "previous"));
    }
  };

  const actions: CardActions = {
    onOpen: (t) => onOpen(t.id),
    onStatus: (t, status) => {
      const found = model.lanes.flatMap((l) => l.cells.flatMap((c) => c.cards)).find((c) => c.task.id === t.id);
      const lane = found && model.lanes.find((l) => l.id === found.lane);
      const cell = lane?.cells.find((c) => c.status === status);
      const move = found && cell && dropPlan(model, found.key, cell.id, cell.cards.filter((c) => c.task.id !== t.id).length, lanes, order);
      if (found && move) apply(found, move, `Moved ${t.subject ?? "the task"} to ${status}.`);
      else if (found && !cell) void changeTask(qc, project.id, t, { status });
    },
    onPriority: (t, priority) => void changeTask(qc, project.id, t, { priority }),
    onMine: (t) => {
      const mine = assignees(t).some((a) => a.toLowerCase() === me.toLowerCase());
      const rows = (t.assigned_to ?? []).filter((r) => !mine || r.user?.toLowerCase() !== me.toLowerCase());
      void changeTask(qc, project.id, t, { assigned_to: mine ? rows : [...rows, { user: me }] });
    },
    onCancel: async (t) => {
      const ok = await confirmDialog({ title: `Cancel “${t.subject ?? "this task"}”?`, message: "It leaves the board. Its record stays, and can be reopened from the task's page.", confirmLabel: "Cancel the task", cancelLabel: "Keep it", danger: true });
      if (ok) void changeTask(qc, project.id, t, { status: "Cancelled" });
    },
  };

  // ── dragging ──

  const allowed = (activeKey: string, id: string): boolean => {
    const from = cellOf.get(activeKey);
    const to = cellById.get(id);
    return !!from && !!to && dropAllowed(lanes, from, to);
  };

  const detect: CollisionDetection = (args) => {
    const active = String(args.active.id);
    const targets = args.droppableContainers.filter((c) => {
      const cell = where.get(String(c.id));
      return !!cell && allowed(active, cell);
    });
    const near = { ...args, droppableContainers: targets };
    const hits = pointerWithin(near);
    let over = (hits.length ? hits : rectIntersection(near))[0]?.id;
    // Between two columns, or just outside the board: the last place it was over still counts.
    if (over === undefined) return lastOver.current ? [{ id: lastOver.current }] : [];
    // Over a column: aim for its nearest card, if it has any.
    if (String(over) in items && items[String(over)].length) {
      const inside = items[String(over)];
      over = closestCenter({ ...near, droppableContainers: targets.filter((c) => c.id !== over && inside.includes(String(c.id))) })[0]?.id ?? over;
    }
    lastOver.current = String(over);
    return [{ id: over }];
  };

  const onDragStart = ({ active }: DragStartEvent) => {
    setHeld(String(active.id));
    setLive(base);
    lastOver.current = null;
  };

  const onDragOver = ({ active, over }: DragOverEvent) => {
    const a = String(active.id);
    if (!over || !live) return setHover(null);
    const o = String(over.id);
    const [from, to] = [where.get(a), where.get(o)];
    setHover(to && allowed(a, to) ? to : null);
    if (!from || !to || from === to || !allowed(a, to)) return;
    const below = !!active.rect.current.translated && active.rect.current.translated.top > over.rect.top + over.rect.height / 2;
    setLive((cur) => {
      if (!cur) return cur;
      const at = o in cur ? cur[to].length : cur[to].indexOf(o) + (below ? 1 : 0);
      return { ...cur, [from]: cur[from].filter((k) => k !== a), [to]: [...cur[to].slice(0, at), a, ...cur[to].slice(at)] };
    });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const a = String(active.id);
    const cur = live ?? base;
    let next = cur;
    if (over) {
      const o = String(over.id);
      const [from, to] = [where.get(a), where.get(o)];
      if (from && from === to && allowed(a, to)) {
        const [x, y] = [cur[to].indexOf(a), cur[to].indexOf(o)];
        if (y >= 0 && x !== y) next = { ...cur, [to]: arrayMove(cur[to], x, y) };
      }
    }
    const into = whereIs(next).get(a);
    setLive(null);
    setHeld(null);
    setHover(null);
    // Nothing under it at all (released outside the board, with no column hovered yet): it goes back.
    if (over && into) drop(a, into, next[into].indexOf(a));
  };

  const cancel = () => {
    setLive(null);
    setHeld(null);
    setHover(null);
  };

  const label = (key: string) => cards.get(key)?.task.subject ?? "the task";
  const cellName = (id: string) => cellById.get(where.get(id) ?? "")?.status ?? "a column";
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${label(String(active.id))}.`,
    onDragOver: ({ active, over }) => (over ? `${label(String(active.id))} is over ${cellName(String(over.id))}.` : undefined),
    onDragEnd: ({ active, over }) => (over ? `${label(String(active.id))} dropped in ${cellName(String(over.id))}.` : `${label(String(active.id))} put back.`),
    onDragCancel: ({ active }) => `Moving ${label(String(active.id))} was cancelled.`,
  };

  const overlay = held ? cards.get(held) : undefined;
  const sortNote = order === "manual" ? null : `Sorted by ${order === "due" ? "due date" : "priority"}: a drop moves the card between columns only.`;
  const laneName = (id: string) => (id === NOBODY ? "Nobody" : lanes === "priority" ? `${id} priority` : names(id));

  return (
    <div className="pj-board-wrap">
      <Bar filters={filters} lanes={lanes} order={order} people={people} parents={parents} names={names} set={setQuery} shown={model.shown} total={model.total} />
      {closed && <Alert tone="info">This project is {project.status?.toLowerCase()}. Its tasks cannot be changed until it is reopened.</Alert>}
      {tasks.total > tasks.rows.length && (
        <Alert tone="warning">
          The board shows the first {TASK_LIMIT} of {tasks.total} tasks. <Link to={`/e/Task?f.project=${project.id}`}>Open the list</Link> to see them all.
        </Alert>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {note}
      </p>
      <p className="sr-only" id="pj-board-help">
        Press Enter to open a task. Hold Shift and use the arrow keys to move it to another column or place. Use the arrow keys or J and K to go from card to card.
      </p>
      {!model.total && (
        <EmptyState title="No tasks yet" icon="board">
          <p className="muted">{canCreate ? "Add the first one with the plus above a column." : "Nothing has been planned in this project."}</p>
        </EmptyState>
      )}
      {model.total > 0 && !model.shown && (
        <EmptyState title="No task matches" icon="search">
          <Button
            onClick={() => {
              setQuery(filterParams(NO_FILTERS));
            }}
          >
            Clear the filters
          </Button>
        </EmptyState>
      )}
      <DndContext sensors={sensors} collisionDetection={detect} accessibility={{ announcements, screenReaderInstructions: { draggable: "Press Enter to open the task." } }} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={cancel}>
        <div className="pj-board" data-ferrum-nocard="" role="region" aria-label="Tasks by status" aria-describedby="pj-board-help" style={{ "--cols": model.statuses.length } as CSSProperties}>
          <div className="pj-heads">
            {model.statuses.map((s) => {
              const n = model.lanes.reduce((sum, l) => sum + (l.cells.find((c) => c.status === s)?.cards.length ?? 0), 0);
              return (
                <div key={s} className="pj-head">
                  <div className="pj-head-line">
                    <Badge tone={statusTone(s)}>{s}</Badge>
                    <span className="faint">{n}</span>
                    {canCreate && s !== "Overdue" && (
                      <button type="button" className="pj-head-add" aria-label={`Add a task to ${s}`} title={`Add a task to ${s}`} aria-expanded={adding === s} onClick={() => setAdding(adding === s ? null : s)}>
                        <Plus size={15} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  {adding === s && <Adder status={s} onCreate={async (subject) => !!(await createTask(qc, project.id, subject, s))} onClose={() => setAdding(null)} />}
                </div>
              );
            })}
          </div>
          {model.lanes.map((lane) => {
            const shown = lanes === "none" || !lane.id ? null : lane.id;
            const isFolded = shown !== null && folded.has(lane.id);
            return (
              <section key={lane.id || "all"} className="pj-lane" aria-label={shown ? laneName(lane.id) : "All tasks"}>
                {shown !== null && (
                  <h3 className="pj-lane-head">
                    <button
                      type="button"
                      aria-expanded={!isFolded}
                      onClick={() =>
                        setFolded((f) => {
                          const n = new Set(f);
                          if (!n.delete(lane.id)) n.add(lane.id);
                          return n;
                        })
                      }
                    >
                      {isFolded ? <ChevronRight size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
                      {lanes === "assignee" && lane.id !== NOBODY && <Avatar email={lane.id} name={names(lane.id)} />}
                      <span>{laneName(lane.id)}</span>
                      <span className="faint">{lane.count}</span>
                    </button>
                  </h3>
                )}
                {!isFolded && (
                  <div className="pj-cells">
                    {lane.cells.map((cell) => (
                      <Cell
                        key={cell.id}
                        id={cell.id}
                        status={cell.status}
                        keys={items[cell.id] ?? []}
                        cards={cards}
                        over={held !== null && hover === cell.id}
                        sortNote={sortNote}
                        canDrag={canWrite}
                        render={(card, props, isHeld) => (
                          <CardView
                            data={cardData(card.task)}
                            selected={open === card.task.id}
                            held={isHeld}
                            menu={<CardMenu task={card.task} me={me} canWrite={canWrite} actions={actions} />}
                            {...props}
                            tabIndex={0}
                            data-card-key={card.key}
                            data-task-id={card.task.id}
                            onClick={(e) => {
                              if (!(e.target as HTMLElement).closest("button, a, [role=menuitem]")) onOpen(card.task.id);
                            }}
                            onKeyDown={(e) => byKey(e, card)}
                          />
                        )}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
        <DragOverlay dropAnimation={reduced() ? null : undefined}>{overlay ? <CardView data={cardData(overlay.task)} data-overlay="" /> : null}</DragOverlay>
      </DndContext>
    </div>
  );
}
