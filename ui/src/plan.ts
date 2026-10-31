// The project view's arithmetic (kept apart, so it is tested): the board's columns, which tasks are
// late, and where each task's bar sits on the timeline.

export interface Task {
  id: string;
  number?: string | null;
  subject?: string | null;
  status?: string | null;
  priority?: string | null;
  exp_start_date?: string | null;
  exp_end_date?: string | null;
  progress?: string | number | null;
  is_milestone?: boolean | null;
  parent_task?: string | null;
  assigned_to?: { user?: string | null }[] | null;
}

/** The board's columns, in order; Overdue shows only when a task is in it, Cancelled never. */
export const COLUMNS = ["Open", "Working", "Overdue", "Pending Review", "Completed"];
export const DONE = ["Completed", "Cancelled"];

export function board(tasks: Task[]): { status: string; tasks: Task[] }[] {
  return COLUMNS.map((status) => ({ status, tasks: tasks.filter((t) => (t.status ?? "Open") === status) })).filter((c) => c.status !== "Overdue" || c.tasks.length);
}

/** Late: due before today and not done (ISO dates compare as text). */
export function late(t: Task, today: string): boolean {
  return !!t.exp_end_date && t.exp_end_date < today && !DONE.includes(t.status ?? "");
}

export function assignees(t: Task): string[] {
  return (t.assigned_to ?? []).map((a) => a.user ?? "").filter(Boolean);
}

const DAY = 86_400_000;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

export interface Bar {
  task: Task;
  /** Where it starts and how long it is, as fractions of the whole span (0..1). */
  left: number;
  width: number;
}

export interface Timeline {
  start: string;
  end: string;
  days: number;
  bars: Bar[];
  /** Tasks with no dates to place. */
  unscheduled: Task[];
  /** First days of the months within the span, with their place. */
  months: { label: string; left: number }[];
}

/** Bars for the tasks that have dates (a task with only one date is a day long; a milestone sits
 *  on its end date), over the span of the tasks and the project's own dates. */
export function timeline(tasks: Task[], projectStart?: string | null, projectEnd?: string | null): Timeline {
  const dated = tasks.filter((t) => t.exp_start_date || t.exp_end_date);
  const unscheduled = tasks.filter((t) => !t.exp_start_date && !t.exp_end_date);
  const spans = dated.map((t) => {
    const end = t.exp_end_date ?? t.exp_start_date!;
    const start = t.is_milestone ? end : (t.exp_start_date ?? end);
    return { task: t, from: ms(start), to: ms(end < start ? start : end) };
  });
  const edges = [...spans.flatMap((s) => [s.from, s.to]), ...[projectStart, projectEnd].filter((d): d is string => !!d).map(ms)];
  if (!edges.length) return { start: "", end: "", days: 0, bars: [], unscheduled, months: [] };
  const first = Math.min(...edges);
  const last = Math.max(...edges);
  const days = Math.round((last - first) / DAY) + 1;
  const bars = spans
    .sort((a, b) => a.from - b.from || a.to - b.to)
    .map((s) => ({ task: s.task, left: (s.from - first) / DAY / days, width: (Math.round((s.to - s.from) / DAY) + 1) / days }));
  // Each month within the span, from where it starts in it (the first may start before the span).
  const months: { label: string; left: number }[] = [];
  const f = new Date(first);
  for (let t = Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), 1); t <= last; ) {
    const m = new Date(t);
    months.push({ label: m.toLocaleString(undefined, { month: "short", year: "numeric", timeZone: "UTC" }), left: Math.max(0, (t - first) / DAY / days) });
    t = Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1);
  }
  return { start: iso(first), end: iso(last), days, bars, unscheduled, months };
}
