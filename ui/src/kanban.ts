// The board's arithmetic: which cards show, in which column and lane, in what order, and what a drop
// or a key press changes. Pure, so the rules of dragging are tested without a browser.

import { diffDays } from "./days";
import { assignees, COLUMNS, late, PRIORITIES, priorityOf, statusOf, type Task } from "./plan";
import { byRank, place } from "./rank";

export type Lanes = "none" | "assignee" | "priority";
export type Order = "manual" | "due" | "priority";

export interface Filters {
  q: string;
  /** "" anyone, "me", "none" for nobody, or a person's address. */
  who: string;
  /** "" any, or one priority. */
  priority: string;
  /** "" any; "late"; "week" (due within seven days); "none" (no due date). */
  due: "" | "late" | "week" | "none";
  /** "" every task; "top" those that are not sub-tasks; or a task's id for its sub-tasks. */
  parent: string;
}

export const NO_FILTERS: Filters = { q: "", who: "", priority: "", due: "", parent: "" };

/** The lane of the tasks nobody is on. No address can be this. */
export const NOBODY = "(nobody)";

const DUE = ["late", "week", "none"];

/** What the address of the page says about the board. Anything unknown is ignored. */
export function readFilters(p: URLSearchParams): Filters {
  const due = p.get("due") ?? "";
  const priority = p.get("prio") ?? "";
  return {
    q: p.get("q") ?? "",
    who: p.get("who") ?? "",
    priority: PRIORITIES.includes(priority) ? priority : "",
    due: DUE.includes(due) ? (due as Filters["due"]) : "",
    parent: p.get("parent") ?? "",
  };
}

/** The same, as changes to the address (null removes one). */
export function filterParams(f: Filters): Record<string, string | null> {
  return { q: f.q || null, who: f.who || null, prio: f.priority || null, due: f.due || null, parent: f.parent || null };
}

export const readLanes = (p: URLSearchParams): Lanes => (p.get("lanes") === "assignee" || p.get("lanes") === "priority" ? (p.get("lanes") as Lanes) : "none");
export const readOrder = (p: URLSearchParams): Order => (p.get("order") === "due" || p.get("order") === "priority" ? (p.get("order") as Order) : "manual");

/** How many of the filters are on (the search box is not counted: it shows its own text). */
export const filtersOn = (f: Filters): number => [f.who, f.priority, f.due, f.parent].filter(Boolean).length;

export function matches(t: Task, f: Filters, me: string, today: string): boolean {
  const q = f.q.trim().toLowerCase();
  if (q && ![t.subject, t.number].some((v) => v?.toLowerCase().includes(q))) return false;
  const who = assignees(t).map((a) => a.toLowerCase());
  if (f.who === "me" && !who.includes(me.toLowerCase())) return false;
  if (f.who === "none" && who.length) return false;
  if (f.who && f.who !== "me" && f.who !== "none" && !who.includes(f.who.toLowerCase())) return false;
  if (f.priority && priorityOf(t) !== f.priority) return false;
  if (f.due === "late" && !late(t, today)) return false;
  if (f.due === "week" && !(t.exp_end_date && diffDays(today, t.exp_end_date) >= 0 && diffDays(today, t.exp_end_date) <= 6)) return false;
  if (f.due === "none" && t.exp_end_date) return false;
  if (f.parent === "top" && t.parent_task) return false;
  if (f.parent && f.parent !== "top" && t.parent_task !== f.parent) return false;
  return true;
}

// ── the model ──

export interface Card {
  /** Unique on the board: a task with two people on it is a card in each of their lanes. */
  key: string;
  task: Task;
  lane: string;
}

export interface Cell {
  id: string;
  lane: string;
  status: string;
  cards: Card[];
}

export interface Lane {
  id: string;
  cells: Cell[];
  count: number;
}

export interface BoardModel {
  statuses: string[];
  lanes: Lane[];
  /** Tasks on the board after the filters, and before them. */
  shown: number;
  total: number;
}

function comparer(order: Order): (a: Task, b: Task) => number {
  if (order === "due") return (a, b) => (a.exp_end_date ?? "9999").localeCompare(b.exp_end_date ?? "9999") || byRank(a, b);
  if (order === "priority") return (a, b) => PRIORITIES.indexOf(priorityOf(a)) - PRIORITIES.indexOf(priorityOf(b)) || byRank(a, b);
  return byRank;
}

function laneKeys(shown: Task[], lanes: Lanes): string[] {
  if (lanes === "priority") return PRIORITIES.filter((p) => shown.some((t) => priorityOf(t) === p));
  if (lanes === "assignee") {
    const people = [...new Set(shown.flatMap((t) => assignees(t).map((a) => a.toLowerCase())))].sort();
    return shown.some((t) => !assignees(t).length) ? [...people, NOBODY] : people;
  }
  return [];
}

function inLane(t: Task, lane: string, lanes: Lanes): boolean {
  if (lanes === "priority") return priorityOf(t) === lane;
  if (lanes === "assignee") return lane === NOBODY ? !assignees(t).length : assignees(t).some((a) => a.toLowerCase() === lane);
  return true;
}

export function boardModel(tasks: Task[], f: Filters, lanes: Lanes, order: Order, ctx: { me: string; today: string }): BoardModel {
  const live = tasks.filter((t) => t.status !== "Cancelled");
  const statuses = COLUMNS.filter((s) => s !== "Overdue" || live.some((t) => statusOf(t) === "Overdue"));
  const shown = live.filter((t) => matches(t, f, ctx.me, ctx.today));
  const cmp = comparer(order);
  // With nothing to group, one lane still holds the columns.
  const keys = laneKeys(shown, lanes);
  const list = (lanes === "none" || !keys.length ? [""] : keys).map((lane): Lane => {
    const mine = shown.filter((t) => inLane(t, lane, lanes === "none" || !keys.length ? "none" : lanes));
    const cells = statuses.map((status): Cell => ({
      id: `${lane}|${status}`,
      lane,
      status,
      cards: mine
        .filter((t) => statusOf(t) === status)
        .sort(cmp)
        .map((task) => ({ key: `${lane}|${task.id}`, task, lane })),
    }));
    return { id: lane, cells, count: mine.length };
  });
  return { statuses, lanes: list, shown: shown.length, total: live.length };
}

export interface Found {
  lane: Lane;
  cell: Cell;
  card: Card;
  /** Where the card stands in its cell. */
  index: number;
}

export function findCard(model: BoardModel, key: string): Found | null {
  for (const lane of model.lanes) {
    for (const cell of lane.cells) {
      const index = cell.cards.findIndex((c) => c.key === key);
      if (index >= 0) return { lane, cell, card: cell.cards[index], index };
    }
  }
  return null;
}

export function findCell(model: BoardModel, id: string): Cell | null {
  for (const lane of model.lanes) {
    const cell = lane.cells.find((c) => c.id === id);
    if (cell) return cell;
  }
  return null;
}

// ── moving ──

/** Overdue follows the dates, so a card cannot be put there; and with a lane per person, a card
 *  stays in its lane (a task with two people on it is in two lanes, and dropping it in one of them
 *  must not say which person it belongs to). */
export function dropAllowed(lanes: Lanes, from: Cell, to: Cell): boolean {
  return to.status !== "Overdue" && (lanes !== "assignee" || to.lane === from.lane);
}

export interface Move {
  /** What to send for the card that moved: only what changes. */
  patch: { status?: string; priority?: string; rank?: string };
  /** Other cards of the cell that had to be ranked again. */
  also: { id: string; rank: string }[];
}

/** What dropping card `key` at position `at` of cell `to` changes (`at` counts the cards of that
 *  cell other than this one). Nothing, when it is put back where it was. Under a sort other than
 *  the manual order a drop moves the card between columns only: where it stands in one is the
 *  sort's to say. */
export function dropPlan(model: BoardModel, key: string, to: string, at: number, lanes: Lanes, order: Order): Move | null {
  const from = findCard(model, key);
  const cell = findCell(model, to);
  if (!from || !cell || !dropAllowed(lanes, from.cell, cell)) return null;
  const t = from.card.task;
  const patch: Move["patch"] = {};
  if (cell.status !== statusOf(t)) patch.status = cell.status;
  if (lanes === "priority" && cell.lane !== priorityOf(t)) patch.priority = cell.lane;
  let also: Move["also"] = [];
  if (order === "manual" && !(from.cell.id === cell.id && from.index === at)) {
    const placed = place(
      cell.cards.filter((c) => c.task.id !== t.id).map((c) => c.task),
      at,
    );
    patch.rank = placed.rank;
    also = placed.also;
  }
  return Object.keys(patch).length ? { patch, also } : null;
}

export type Way = "left" | "right" | "up" | "down";

/** Where a key press puts a card: one column over (to the same height, or the foot of a shorter
 *  one) or one place up or down its column. Null where it cannot go. */
export function keyMove(model: BoardModel, key: string, way: Way, order: Order): { to: string; at: number } | null {
  const at = findCard(model, key);
  if (!at) return null;
  if (way === "up" || way === "down") {
    const next = at.index + (way === "up" ? -1 : 1);
    return order === "manual" && next >= 0 && next < at.cell.cards.length ? { to: at.cell.id, at: next } : null;
  }
  const cells = at.lane.cells;
  const step = way === "left" ? -1 : 1;
  for (let i = cells.indexOf(at.cell) + step; i >= 0 && i < cells.length; i += step) {
    if (cells[i].status === "Overdue") continue;
    return { to: cells[i].id, at: Math.min(at.index, cells[i].cards.length) };
  }
  return null;
}

/** The card to put focus on after a key: up and down walk one column, left and right go to the
 *  nearest column with cards at the same height. `next`/`previous` read the whole board in order. */
export function focusMove(model: BoardModel, key: string, way: Way | "next" | "previous"): string | null {
  const at = findCard(model, key);
  if (!at) return null;
  if (way === "up" || way === "down") return at.cell.cards[at.index + (way === "up" ? -1 : 1)]?.key ?? null;
  if (way === "left" || way === "right") {
    const cells = at.lane.cells;
    const step = way === "left" ? -1 : 1;
    for (let i = cells.indexOf(at.cell) + step; i >= 0 && i < cells.length; i += step) {
      const cards = cells[i].cards;
      if (cards.length) return cards[Math.min(at.index, cards.length - 1)].key;
    }
    return null;
  }
  const all = model.lanes.flatMap((l) => l.cells.flatMap((c) => c.cards));
  const i = all.findIndex((c) => c.key === key);
  return all[i + (way === "next" ? 1 : -1)]?.key ?? null;
}
