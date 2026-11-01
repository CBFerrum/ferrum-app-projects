// What the screens share about a task: its shape as the API sends it, who works on it, and when it
// is late. Kept apart from the screens so it is tested without a browser.

export interface Task {
  id: string;
  /** The version the card was loaded at: a change sends it back, so a stale edit is refused. */
  version?: number;
  number?: string | null;
  subject?: string | null;
  project?: string | null;
  status?: string | null;
  priority?: string | null;
  exp_start_date?: string | null;
  exp_end_date?: string | null;
  expected_hours?: string | number | null;
  actual_hours?: string | number | null;
  progress?: string | number | null;
  is_milestone?: boolean | null;
  parent_task?: string | null;
  /** Manual order within a status (a decimal, so a card can land between two others). */
  rank?: string | number | null;
  assigned_to?: { id?: string; user?: string | null }[] | null;
  depends_on?: { id?: string; task?: string | null }[] | null;
  _titles?: Record<string, string>;
}

/** The board's columns in order; Overdue shows only while a task is in it, Cancelled never. */
export const COLUMNS = ["Open", "Overdue", "Working", "Pending Review", "Completed"];
export const DONE = ["Completed", "Cancelled"];
/** The statuses a person can choose: Overdue follows the dates, and cancelling asks first. */
export const CHOOSABLE = ["Open", "Working", "Pending Review", "Completed"];
/** Most pressing first. */
export const PRIORITIES = ["Urgent", "High", "Medium", "Low"];

export const num = (v: string | number | null | undefined): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export const statusOf = (t: Task): string => t.status ?? "Open";
export const priorityOf = (t: Task): string => t.priority ?? "Medium";

/** Late: due before today and not done (ISO dates compare as text). */
export function late(t: Task, today: string): boolean {
  return !!t.exp_end_date && t.exp_end_date < today && !DONE.includes(statusOf(t));
}

export function assignees(t: Task): string[] {
  return (t.assigned_to ?? []).map((a) => a.user ?? "").filter(Boolean);
}

/** The tasks this one waits for, ids only. */
export function waitsFor(t: Task): string[] {
  return (t.depends_on ?? []).map((d) => d.task ?? "").filter(Boolean);
}

/** "AR" for asha.rao@acme.test: a person's mark where only their address is known. */
export function mark(email?: string | null): string {
  const name = (email ?? "").split("@")[0].split(/[._-]+/).filter(Boolean);
  return (name.length > 1 ? name[0][0] + name[1][0] : (name[0] ?? "?").slice(0, 2)).toUpperCase();
}

/** Hours still to go on a task: the estimate less what was logged, never below nothing. */
export function hoursLeft(t: Task): number {
  return Math.max(0, num(t.expected_hours) - num(t.actual_hours));
}

/** Sub-tasks done of all, for each parent that has any (cancelled ones do not count). */
export function subtaskCounts(tasks: Task[]): Map<string, { done: number; total: number }> {
  const out = new Map<string, { done: number; total: number }>();
  for (const t of tasks) {
    if (!t.parent_task || t.status === "Cancelled") continue;
    const c = out.get(t.parent_task) ?? { done: 0, total: 0 };
    c.total++;
    if (t.status === "Completed") c.done++;
    out.set(t.parent_task, c);
  }
  return out;
}

/** The tasks a task waits for that are not completed yet: what keeps it from starting. The server
 *  holds the same rule (only a completed task releases those after it). */
export function blockers(t: Task, byId: Map<string, Task>): Task[] {
  return waitsFor(t)
    .map((id) => byId.get(id))
    .filter((p): p is Task => !!p && p.status !== "Completed");
}

/** Replaces the fields of one task in a list, leaving the rest. */
export function patched(tasks: Task[], id: string, change: Partial<Task>): Task[] {
  return tasks.map((t) => (t.id === id ? { ...t, ...change } : t));
}
