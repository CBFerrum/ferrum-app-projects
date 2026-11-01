// What is on someone's plate: their open tasks across projects, by when they fall due or by project,
// and what that comes to. Pure, so it is tested without a browser.

import { diffDays } from "./days";
import { DONE, hoursLeft, PRIORITIES, priorityOf, type Task } from "./plan";

export type Horizon = "Overdue" | "Today" | "Next 7 days" | "Later" | "No date";
export const HORIZONS: Horizon[] = ["Overdue", "Today", "Next 7 days", "Later", "No date"];

/** When a task falls due, from today's point of view. */
export function horizon(due: string | null | undefined, today: string): Horizon {
  if (!due) return "No date";
  const days = diffDays(today, due);
  return days < 0 ? "Overdue" : days === 0 ? "Today" : days <= 7 ? "Next 7 days" : "Later";
}

export interface Group {
  key: string;
  label: string;
  tasks: Task[];
}

/** The soonest due first, undated last; then the more pressing, then in the order they were made. */
function soonest(a: Task, b: Task): number {
  return (
    (a.exp_end_date ?? "9999").localeCompare(b.exp_end_date ?? "9999") ||
    PRIORITIES.indexOf(priorityOf(a)) - PRIORITIES.indexOf(priorityOf(b)) ||
    (a.number ?? "").localeCompare(b.number ?? "", undefined, { numeric: true }) ||
    a.id.localeCompare(b.id)
  );
}

/** Open tasks only; a done task is nobody's work. */
const open = (tasks: Task[]): Task[] => tasks.filter((t) => !DONE.includes(t.status ?? "Open"));

export function byHorizon(tasks: Task[], today: string): Group[] {
  const sorted = open(tasks).sort(soonest);
  return HORIZONS.map((h) => ({ key: h, label: h, tasks: sorted.filter((t) => horizon(t.exp_end_date, today) === h) })).filter((g) => g.tasks.length);
}

/** Projects with the soonest-due work first; `name` says what a project is called. */
export function byProject(tasks: Task[], name: (t: Task) => string): Group[] {
  const groups = new Map<string, Group>();
  for (const t of open(tasks).sort(soonest)) {
    const key = t.project ?? "";
    const g = groups.get(key) ?? { key, label: name(t) || "No project", tasks: [] };
    g.tasks.push(t);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => (a.tasks[0].exp_end_date ?? "9999").localeCompare(b.tasks[0].exp_end_date ?? "9999") || a.label.localeCompare(b.label));
}

export interface Plate {
  open: number;
  late: number;
  today: number;
  /** Hours still to go on the tasks that have an estimate. */
  hours: number;
}

export function plate(tasks: Task[], today: string): Plate {
  const mine = open(tasks);
  return {
    open: mine.length,
    late: mine.filter((t) => horizon(t.exp_end_date, today) === "Overdue").length,
    today: mine.filter((t) => horizon(t.exp_end_date, today) === "Today").length,
    hours: mine.reduce((n, t) => n + hoursLeft(t), 0),
  };
}
