// The timeline's arithmetic: where a task's bar sits, what dragging it changes, and what follows
// from it. A task waits for the ones it depends on: its first day comes after their last (the
// server holds the other half of that rule, that it cannot start before they are completed).
// Moving a task moves only what its links force, by as little as they force, and says so before
// anything is written. Pure, so it is tested without a browser.

import { addDays, dayNumber, dayOf, diffDays, isWeekend, weekStart } from "./days";
import { type Task, waitsFor } from "./plan";

/** A run of days, the first and the last both counted. */
export interface Span {
  start: string;
  end: string;
}

export const length = (s: Span): number => diffDays(s.start, s.end) + 1;

/** A task's days. A task with one date takes that day; a milestone is a point, on its end date. */
export function spanOf(t: Task): Span | null {
  const { exp_start_date: s, exp_end_date: e } = t;
  if (!s && !e) return null;
  const end = (e ?? s) as string;
  const start = t.is_milestone ? end : (s ?? end);
  return start > end ? { start: end, end } : { start, end };
}

// ── the view ──

export type Zoom = "day" | "week" | "month" | "quarter";
export const ZOOMS: Zoom[] = ["day", "week", "month", "quarter"];
/** Pixels a day takes at each zoom. */
export const PX: Record<Zoom, number> = { day: 36, week: 14, month: 5, quarter: 2 };

export const readZoom = (v: string | null): Zoom => (ZOOMS.includes(v as Zoom) ? (v as Zoom) : "week");

export interface View {
  zoom: Zoom;
  from: string;
  to: string;
  days: number;
  px: number;
}

const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const nextMonth = (d: string) => dayOf(Math.round(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 1) / 86_400_000));
const quarterStart = (d: string) => `${d.slice(0, 4)}-${String(Math.floor((Number(d.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
const nextQuarter = (d: string) => nextMonth(nextMonth(nextMonth(quarterStart(d))));
const yearStart = (d: string) => `${d.slice(0, 4)}-01-01`;
const nextYear = (d: string) => `${Number(d.slice(0, 4)) + 1}-01-01`;

/** The days the timeline shows: every span, today, and some room either side, rounded out to whole
 *  weeks (day and week zoom) or months (month and quarter zoom). */
export function viewOf(spans: Span[], today: string, zoom: Zoom): View {
  const days = [...spans.flatMap((s) => [s.start, s.end]), today];
  const first = addDays(days.reduce((a, b) => (a < b ? a : b)), -7);
  const last = addDays(days.reduce((a, b) => (a > b ? a : b)), 21);
  const coarse = zoom === "month" || zoom === "quarter";
  const from = coarse ? (zoom === "quarter" ? quarterStart(first) : monthStart(first)) : weekStart(first);
  let to = coarse ? addDays(zoom === "quarter" ? nextQuarter(last) : nextMonth(last), -1) : addDays(weekStart(last), 6);
  // Never narrower than a screen of the finest zoom.
  const min = 42;
  if (diffDays(from, to) + 1 < min) to = addDays(from, min - 1);
  return { zoom, from, to, days: diffDays(from, to) + 1, px: PX[zoom] };
}

/** A label over a run of days: where it starts and how long it is, in days from the view's start. */
export interface Tick {
  label: string;
  at: number;
  span: number;
}

function run(v: View, start: (d: string) => string, next: (d: string) => string, label: (d: string) => string): Tick[] {
  const out: Tick[] = [];
  const stop = addDays(v.to, 1);
  for (let d = start(v.from), guard = 0; d < stop && guard < 5000; d = next(d), guard++) {
    const lo = d < v.from ? v.from : d;
    const hi = next(d) > stop ? stop : next(d);
    out.push({ label: label(d), at: diffDays(v.from, lo), span: diffDays(lo, hi) });
  }
  return out;
}

const monthYear = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
const monthName = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", timeZone: "UTC" });
const dom = (d: string) => String(Number(d.slice(8)));

/** The two lines of the timeline's header: months over days or weeks, years over months or quarters. */
export function header(v: View): { top: Tick[]; bottom: Tick[] } {
  switch (v.zoom) {
    case "day":
      return { top: run(v, monthStart, nextMonth, monthYear), bottom: run(v, (d) => d, (d) => addDays(d, 1), dom) };
    case "week":
      return { top: run(v, monthStart, nextMonth, monthYear), bottom: run(v, weekStart, (d) => addDays(d, 7), dom) };
    case "month":
      return { top: run(v, yearStart, nextYear, (d) => d.slice(0, 4)), bottom: run(v, monthStart, nextMonth, monthName) };
    default:
      return { top: run(v, yearStart, nextYear, (d) => d.slice(0, 4)), bottom: run(v, quarterStart, nextQuarter, (d) => `Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`) };
  }
}

/** Saturdays and Sundays, to shade, where a day is wide enough to tell. */
export function weekends(v: View): { at: number; span: number }[] {
  if (v.zoom === "month" || v.zoom === "quarter") return [];
  const out: { at: number; span: number }[] = [];
  for (let d = v.from, i = 0; d <= v.to; d = addDays(d, 1), i++) {
    if (isWeekend(d) && !(out.length && out[out.length - 1].at + out[out.length - 1].span === i)) out.push({ at: i, span: 1 });
    else if (isWeekend(d)) out[out.length - 1].span++;
  }
  return out;
}

/** Where a day falls in the view, in days from its start. */
export const dayAt = (v: View, day: string): number => diffDays(v.from, day);

/** The day under a position, in days from the view's start. */
export const dayUnder = (v: View, x: number): string => addDays(v.from, Math.floor(x / v.px));

/** Dates for a task given by a click on its empty row: the day clicked and one more (a week at quarter zoom). */
export const firstDates = (day: string, zoom: Zoom): Span => ({ start: day, end: addDays(day, zoom === "quarter" ? 6 : 1) });

// ── the rows ──

export interface Row {
  task: Task;
  depth: number;
  kids: number;
  /** The task's own days, or those of its sub-tasks where it has none. */
  span: Span | null;
  /** Drawn from its sub-tasks: not the task's own dates. */
  summary: boolean;
}

export interface Outline {
  rows: Row[];
  /** Tasks (and their sub-tasks) with no dates anywhere: they have no place on the timeline yet. */
  unscheduled: Task[];
}

const union = (spans: (Span | null)[]): Span | null => {
  const some = spans.filter((s): s is Span => !!s);
  return some.length ? { start: some.reduce((a, s) => (s.start < a ? s.start : a), some[0].start), end: some.reduce((a, s) => (s.end > a ? s.end : a), some[0].end) } : null;
};

/** The tasks as a tree by parent, in order of their first day. Folded parents hide their sub-tasks. */
export function outline(tasks: Task[], folded: ReadonlySet<string>): Outline {
  const live = tasks.filter((t) => t.status !== "Cancelled");
  const ids = new Set(live.map((t) => t.id));
  const kids = new Map<string, Task[]>();
  for (const t of live) if (t.parent_task && ids.has(t.parent_task)) kids.set(t.parent_task, [...(kids.get(t.parent_task) ?? []), t]);
  const tree = new Map<string, Span | null>();
  const whole = (t: Task, seen = new Set<string>()): Span | null => {
    if (tree.has(t.id)) return tree.get(t.id)!;
    if (seen.has(t.id)) return spanOf(t);
    seen.add(t.id);
    const s = union([spanOf(t), ...(kids.get(t.id) ?? []).map((k) => whole(k, seen))]);
    tree.set(t.id, s);
    return s;
  };
  const order = (a: Task, b: Task) => (whole(a)?.start ?? "9999").localeCompare(whole(b)?.start ?? "9999") || (a.number ?? "").localeCompare(b.number ?? "", undefined, { numeric: true }) || a.id.localeCompare(b.id);
  const roots = live.filter((t) => !t.parent_task || !ids.has(t.parent_task)).sort(order);
  const rows: Row[] = [];
  const unscheduled: Task[] = [];
  const walk = (t: Task, depth: number, seen: Set<string>) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    const own = spanOf(t);
    const below = [...(kids.get(t.id) ?? [])].sort(order);
    rows.push({ task: t, depth, kids: below.length, span: own ?? whole(t), summary: !own && !!whole(t) });
    if (!folded.has(t.id)) for (const k of below) walk(k, depth + 1, seen);
  };
  const flat = (t: Task, seen: Set<string>) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    unscheduled.push(t);
    for (const k of [...(kids.get(t.id) ?? [])].sort(order)) flat(k, seen);
  };
  const seen = new Set<string>();
  for (const r of roots) {
    if (whole(r)) walk(r, 0, seen);
    else flat(r, seen);
  }
  return { rows, unscheduled };
}

// ── links ──

export interface Link {
  /** The task that comes first, and the one that waits for it. */
  from: string;
  to: string;
  /** The waiting task starts after the other ends. */
  ok: boolean;
}

/** The links between tasks that both have a row with days. */
export function links(rows: Row[]): Link[] {
  const at = new Map(rows.filter((r) => r.span).map((r) => [r.task.id, r.span as Span]));
  return rows.flatMap((r) =>
    waitsFor(r.task)
      .filter((p) => at.has(p) && r.span)
      .map((p) => ({ from: p, to: r.task.id, ok: (r.span as Span).start > (at.get(p) as Span).end })),
  );
}

/** A line from the end of one bar to the start of the next, with elbows; round the back when the
 *  second starts before the first ends. Rows are `gap` apart. */
export function arrow(x1: number, y1: number, x2: number, y2: number, gap = 36): string {
  const out = x1 + 8;
  if (x2 >= out + 8) return `M${x1},${y1} H${Math.min(out, x2 - 8)} V${y2} H${x2}`;
  const mid = y1 + (y2 >= y1 ? gap / 2 : -gap / 2);
  return `M${x1},${y1} H${out} V${mid} H${x2 - 8} V${y2} H${x2}`;
}

// ── dragging ──

export type Mode = "move" | "start" | "end";

export interface Edit {
  id: string;
  start: string;
  end: string;
}

/** What dragging a task's bar `days` days gives it: the whole bar moved, or one end of it, which
 *  never goes past the other. A milestone only moves. */
export function dragged(task: Task, mode: Mode, days: number): Edit | null {
  const s = spanOf(task);
  if (!s) return null;
  if (mode === "move" || task.is_milestone) return { id: task.id, start: addDays(s.start, days), end: addDays(s.end, days) };
  if (mode === "start") return { id: task.id, start: addDays(s.start, days) > s.end ? s.end : addDays(s.start, days), end: s.end };
  return { id: task.id, start: s.start, end: addDays(s.end, days) < s.start ? s.start : addDays(s.end, days) };
}

export interface Change {
  id: string;
  /** Dragged by the person; pushed later by a link; pulled earlier by one; or carried with its parent. */
  kind: "dragged" | "pushed" | "pulled" | "child";
  before: Span | null;
  after: Span;
}

export interface Plan {
  changes: Change[];
  /** Tasks that would have followed but have no days to move. */
  skipped: string[];
}

/** Every pass is bounded: the server refuses a cycle, but the screen must not hang on bad data. */
const BOUND = 20_000;

/**
 * What a set of edits moves. The edits stand as given. After each edited task, the tasks that
 * wait for it move later only if their link would break, and by as little as keeps it whole, each
 * keeping its own length, and so on down the chain; tasks without days are left alone and named.
 * An edited task dragged to start before the one it waits for ends pulls that one earlier, by as
 * much as it overlaps, and so on up the chain. A parent moved whole takes its dated sub-tasks with it.
 */
export function cascade(tasks: Task[], edits: Edit[]): Plan {
  const live = tasks.filter((t) => t.status !== "Cancelled");
  const known = new Set(live.map((t) => t.id));
  const cur = new Map<string, Span>();
  for (const t of live) {
    const s = spanOf(t);
    if (s) cur.set(t.id, s);
  }
  const before = new Map(cur);
  const kind = new Map<string, Change["kind"]>();
  const fixed = new Set(edits.filter((e) => known.has(e.id)).map((e) => e.id));
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  const kids = new Map<string, string[]>();
  for (const t of live) {
    for (const p of waitsFor(t)) {
      if (!known.has(p)) continue;
      preds.set(t.id, [...(preds.get(t.id) ?? []), p]);
      succs.set(p, [...(succs.get(p) ?? []), t.id]);
    }
    if (t.parent_task && known.has(t.parent_task)) kids.set(t.parent_task, [...(kids.get(t.parent_task) ?? []), t.id]);
  }
  const shift = (id: string, by: number, why: Change["kind"]) => {
    const s = cur.get(id);
    if (!s || !by) return;
    cur.set(id, { start: addDays(s.start, by), end: addDays(s.end, by) });
    if (!kind.has(id)) kind.set(id, why);
  };
  const below = (id: string, seen = new Set<string>()): string[] => (kids.get(id) ?? []).flatMap((k) => (seen.has(k) ? [] : (seen.add(k), [k, ...below(k, seen)])));

  const queue: string[] = [];
  for (const e of edits) {
    if (!fixed.has(e.id)) continue;
    const was = before.get(e.id);
    cur.set(e.id, { start: e.start, end: e.end });
    kind.set(e.id, "dragged");
    queue.push(e.id);
    if (was && diffDays(was.start, e.start) === diffDays(was.end, e.end)) {
      for (const k of below(e.id)) {
        if (fixed.has(k) || !cur.has(k)) continue;
        shift(k, diffDays(was.start, e.start), "child");
        queue.push(k);
      }
    }
  }

  // Up: whatever an edited task now starts before the end of is pulled earlier.
  const back = [...fixed];
  for (let i = 0; i < back.length && i < BOUND; i++) {
    const s = cur.get(back[i]);
    if (!s) continue;
    for (const p of preds.get(back[i]) ?? []) {
      const ps = cur.get(p);
      if (fixed.has(p) || !ps) continue;
      const over = diffDays(s.start, ps.end) + 1;
      if (over > 0) {
        shift(p, -over, "pulled");
        back.push(p);
      }
    }
  }

  // Down: whatever waits for a moved task moves later if its link would break.
  const skipped = new Set<string>();
  for (let i = 0; i < queue.length && i < BOUND; i++) {
    const s = cur.get(queue[i]);
    if (!s) continue;
    for (const next of succs.get(queue[i]) ?? []) {
      if (fixed.has(next)) continue;
      const ns = cur.get(next);
      if (!ns) {
        skipped.add(next);
        continue;
      }
      const late = diffDays(ns.start, s.end) + 1;
      if (late > 0) {
        shift(next, late, "pushed");
        queue.push(next);
      }
    }
  }

  const changes: Change[] = [];
  for (const [id, after] of cur) {
    const was = before.get(id) ?? null;
    if (!was || was.start !== after.start || was.end !== after.end) changes.push({ id, kind: kind.get(id) ?? "pushed", before: was, after });
  }
  const rank = { dragged: 0, child: 1, pulled: 2, pushed: 3 };
  changes.sort((a, b) => rank[a.kind] - rank[b.kind] || a.after.start.localeCompare(b.after.start));
  return { changes, skipped: [...skipped] };
}

/** What to write to a task for one change. Dates the person dragged are written as they stand;
 *  the others move by the days they moved, so a task keeps the dates it had and no more. */
export function writes(task: Task, c: Change): Pick<Task, "exp_start_date" | "exp_end_date"> {
  if (c.kind === "dragged" && !task.is_milestone) return { exp_start_date: c.after.start, exp_end_date: c.after.end };
  const by = c.before ? diffDays(c.before.end, c.after.end) : 0;
  return {
    exp_start_date: task.exp_start_date ? addDays(task.exp_start_date, by) : (task.exp_start_date ?? null),
    exp_end_date: task.exp_end_date ? addDays(task.exp_end_date, by) : (task.exp_end_date ?? null),
  };
}

// ── the critical path ──

/**
 * Tasks with no room to slip. Each task is placed as early as its links allow (a task with nothing
 * before it where it is planned); the project ends when the last of them does; and working back
 * from that day through the links, a linked task whose latest possible end is the day it ends
 * has none to spare. A task that could end days later without moving anything after it, or the
 * project's end, is not on the path, however late it is planned.
 */
export function critical(tasks: Task[]): Set<string> {
  const live = tasks.filter((t) => t.status !== "Cancelled");
  const span = new Map<string, Span>();
  for (const t of live) {
    const s = spanOf(t);
    if (s) span.set(t.id, s);
  }
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const t of live) {
    for (const p of waitsFor(t)) {
      if (!span.has(p) || !span.has(t.id)) continue;
      preds.set(t.id, [...(preds.get(t.id) ?? []), p]);
      succs.set(p, [...(succs.get(p) ?? []), t.id]);
    }
  }
  const walking = new Set<string>();
  const early = new Map<string, number>();
  /** The earliest day the task can end on. */
  const earliestEnd = (id: string): number => {
    const known = early.get(id);
    if (known !== undefined) return known;
    const s = span.get(id) as Span;
    if (walking.has(id)) return dayNumber(s.end);
    walking.add(id);
    const before = preds.get(id) ?? [];
    const start = before.length ? Math.max(...before.map((p) => earliestEnd(p) + 1)) : dayNumber(s.start);
    walking.delete(id);
    early.set(id, start + length(s) - 1);
    return start + length(s) - 1;
  };
  if (!span.size) return new Set();
  const last = Math.max(...[...span.keys()].map(earliestEnd));
  const late = new Map<string, number>();
  const latestEnd = (id: string): number => {
    const known = late.get(id);
    if (known !== undefined) return known;
    if (walking.has(id)) return last;
    walking.add(id);
    let end = last;
    for (const s of succs.get(id) ?? []) end = Math.min(end, latestEnd(s) - length(span.get(s) as Span));
    walking.delete(id);
    late.set(id, end);
    return end;
  };
  return new Set([...span.keys()].filter((id) => (preds.has(id) || succs.has(id)) && latestEnd(id) <= earliestEnd(id)));
}
