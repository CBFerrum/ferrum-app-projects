// One task's story: what happened to it, in the order it happened with the newest first. The
// changes come from the record's history, the talk from its comments and the work from the time
// logged on it. Pure, so it is tested without a browser.

export interface AuditEvent {
  id?: number;
  at: string;
  actor?: string | null;
  actor_name?: string | null;
  action: string;
  diff?: Record<string, unknown> | null;
}

export interface Comment {
  id: string;
  body: string;
  author?: string | null;
  created_at: string;
  edited_at?: string | null;
}

/** A line of time logged on a task, as the app's endpoint gives it (`/api/app/projects/time`). */
export interface TimeRow {
  timesheet: string;
  user?: string | null;
  /** Of the timesheet: 1 is submitted, which is when the hours count toward the task's. */
  docstatus: number;
  at?: string | null;
  hours?: string | number | null;
  what?: string | null;
}

/** Time logged on a task. */
export interface Log {
  key: string;
  at: string;
  hours: number;
  user: string;
  what: string;
  /** In a submitted timesheet: only these count toward the task's hours. */
  counted: boolean;
}

export interface Item {
  key: string;
  at: string;
  kind: "created" | "status" | "change" | "comment" | "time";
  title: string;
  detail?: string | null;
  who?: string | null;
}

/** The time logged on a task, newest first. A cancelled timesheet is no part of the story. */
export function logsOf(rows: TimeRow[]): Log[] {
  return rows
    .filter((r) => r.docstatus !== 2)
    .map((r, i): Log => ({ key: `t-${r.timesheet}-${i}`, at: r.at ?? "", hours: Number(r.hours ?? 0) || 0, user: r.user ?? "", what: r.what ?? "", counted: r.docstatus === 1 }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

export const counted = (logs: Log[]): number => logs.filter((l) => l.counted).reduce((n, l) => n + l.hours, 0);

/** What the history tells about, and how it is called. What is left out is the record's bookkeeping. */
const TOLD: Record<string, string> = {
  status: "Status",
  priority: "Priority",
  exp_start_date: "Starts",
  exp_end_date: "Due",
  progress: "Progress",
  subject: "Title",
  expected_hours: "Estimate",
  is_milestone: "Milestone",
};

const SAID: Record<string, string> = {
  assigned_to: "The people on it changed",
  depends_on: "What it waits for changed",
  parent_task: "It moved under another task",
  project: "It moved to another project",
  description: "The description changed",
};

function changed(diff: unknown): [unknown, unknown] | null {
  if (Array.isArray(diff) && diff.length === 2) return [diff[0], diff[1]];
  if (diff && typeof diff === "object" && "new" in diff) return [(diff as { old?: unknown }).old, (diff as { new?: unknown }).new];
  return null;
}

/** "Status: Open → Working" for each change worth telling; `name` gives a stored value its words. */
export function changes(e: AuditEvent, name: (field: string, value: unknown) => string): string[] {
  const out: string[] = [];
  for (const [field, diff] of Object.entries(e.diff ?? {})) {
    if (SAID[field]) {
      out.push(SAID[field]);
      continue;
    }
    const label = TOLD[field];
    const c = label ? changed(diff) : null;
    if (!label || !c) continue;
    const [was, now] = [name(field, c[0]), name(field, c[1])];
    out.push(was && now ? `${label}: ${was} → ${now}` : now ? `${label}: ${now}` : `${label} cleared`);
  }
  return out;
}

export function story(events: AuditEvent[], comments: Comment[], logs: Log[], name: (field: string, value: unknown) => string): Item[] {
  const items: Item[] = [];
  for (const e of events) {
    const who = e.actor_name ?? (e.actor ? "Someone" : "Ferrum");
    if (e.action === "create") {
      items.push({ key: `e-${e.id ?? e.at}`, at: e.at, kind: "created", title: "Task created", who });
      continue;
    }
    const told = changes(e, name);
    if (told.length) items.push({ key: `e-${e.id ?? e.at}`, at: e.at, kind: told.some((t) => t.startsWith("Status:")) ? "status" : "change", title: told.join(" · "), who });
  }
  for (const c of comments) items.push({ key: `c-${c.id}`, at: c.created_at, kind: "comment", title: "Commented", detail: c.body, who: c.author ?? "Someone" });
  for (const l of logs) items.push({ key: l.key, at: l.at, kind: "time", title: `${l.hours} h logged${l.counted ? "" : " (timesheet not submitted)"}`, detail: l.what || null, who: l.user });
  return items.sort((a, b) => b.at.localeCompare(a.at));
}
