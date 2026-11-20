// The backlog's arithmetic (sprints and the backlog): a project's active sprint, its planned sprints and the backlog (its open tasks in no
// sprint), each with its tasks, points and what is still open; and where a task lands when it is moved up the
// backlog. Pure, so it is tested without a browser.

import { num, type Task } from "./plan";
import { byRank, place } from "./rank";

export interface Sprint {
  id: string;
  version?: number;
  sprint_name: string;
  start_date: string;
  end_date: string;
  goal?: string | null;
  state: "Planned" | "Active" | "Closed";
  committed_points?: string | number | null;
  committed_tasks?: number | null;
}

export interface Section {
  /** The sprint, or null for the backlog. */
  sprint: Sprint | null;
  tasks: Task[];
  points: number;
  /** Tasks not completed. */
  open: number;
}

/** The backlog's order: its own rank (`backlog_rank`), the unranked after, by number. */
const asRanked = (t: Task) => ({ id: t.id, number: t.number, rank: t.backlog_rank });
const byBacklog = (a: Task, b: Task) => byRank(asRanked(a), asRanked(b));

const section = (sprint: Sprint | null, tasks: Task[]): Section => ({
  sprint,
  tasks,
  points: tasks.reduce((n, t) => n + num(t.story_points), 0),
  open: tasks.filter((t) => t.status !== "Completed").length,
});

/** The active sprint, the planned ones by start, then the backlog. A task of a sprint not shown (a closed one's
 *  finished work) is in no section; a cancelled task is in none; a completed one is not in the backlog. */
export function backlogModel(tasks: Task[], sprints: Sprint[]): { sections: Section[] } {
  const live = [...sprints.filter((s) => s.state === "Active"), ...sprints.filter((s) => s.state === "Planned").sort((a, b) => a.start_date.localeCompare(b.start_date))];
  const sections = live.map((s) => section(s, tasks.filter((t) => t.sprint === s.id && t.status !== "Cancelled").sort(byRank)));
  const backlog = tasks.filter((t) => !t.sprint && t.status !== "Completed" && t.status !== "Cancelled").sort(byBacklog);
  return { sections: [...sections, section(null, backlog)] };
}

/** The `backlog_rank` changes that move `id` to the top, one up or one down the backlog (`tasks`, in any order):
 *  the task's own and any neighbour's that had none; null when it is already there. */
export function placeAt(tasks: Task[], id: string, where: "top" | "up" | "down"): { id: string; backlog_rank: string }[] | null {
  const order = [...tasks].sort(byBacklog);
  const i = order.findIndex((t) => t.id === id);
  if (i < 0) return null;
  const to = where === "top" ? 0 : where === "up" ? i - 1 : i + 1;
  if (to < 0 || to === i || to >= order.length) return null;
  const rest = order.filter((t) => t.id !== id).map(asRanked);
  const p = place(rest, to);
  return [{ id, backlog_rank: p.rank }, ...p.also.map((a) => ({ id: a.id, backlog_rank: a.rank }))];
}
