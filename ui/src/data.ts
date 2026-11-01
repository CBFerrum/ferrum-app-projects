// What the screens ask of the API, and how a task is changed: shown at once, sent with the version
// on screen, and put back with the server's reason if it refuses. The server holds the rules (what
// may start, what may close, who may change what); the screens only show what it says.

import { type QueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import { api, ApiError, docPath, errorMessage, newKey } from "@ferrum/client";
import { toast } from "@ferrum/kit";
import { usePeople } from "@ferrum/records";
import { patched, type Task } from "./plan";

export interface Project {
  id: string;
  number?: string | null;
  project_name?: string | null;
  status?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  customer?: string | null;
  company?: string | null;
  currency?: string | null;
  budget?: string | number | null;
  proj_priority?: string | null;
  proj_project_manager?: string | null;
  proj_percent_complete?: string | number | null;
  proj_billing_method?: string | null;
  proj_contract_value?: string | number | null;
  proj_estimated_cost?: string | number | null;
  proj_estimated_hours?: string | number | null;
  proj_actual_hours?: string | number | null;
  proj_costing_amount?: string | number | null;
  proj_billable_amount?: string | number | null;
  proj_billed_amount?: string | number | null;
  _titles?: Record<string, string>;
}

export interface Rows<T> {
  rows: T[];
  total?: number;
}

export const list = <T,>(entity: string, query: Record<string, string | number | boolean>, signal?: AbortSignal) => api.get<Rows<T>>(`/api/v1/${entity}`, query, signal);

/** The fields of a task the screens keep from what the server answers a change with. */
const KEPT = new Set([
  "id",
  "version",
  "number",
  "subject",
  "project",
  "status",
  "priority",
  "exp_start_date",
  "exp_end_date",
  "expected_hours",
  "actual_hours",
  "progress",
  "is_milestone",
  "parent_task",
  "rank",
  "assigned_to",
  "depends_on",
]);

/** A project's tasks, and how many it has (more than the screens load, when the two differ). */
export interface TaskSet {
  rows: Task[];
  total: number;
}

export const tasksKey = (project: string) => ["projects", "tasks", project];

/** The most tasks a screen loads; the API's own limit. */
export const TASK_LIMIT = 500;

/** A project's tasks with the people on each and what each waits for: a list leaves those out (they
 *  are child rows), so Projects' own endpoint adds them, with the caller's own rights. */
export async function loadTasks(project: string, signal?: AbortSignal): Promise<TaskSet> {
  const r = await api.get<Rows<Task>>("/api/app/projects/tasks", { project }, signal);
  return { rows: r.rows, total: r.total ?? r.rows.length };
}

/** A saved task, cut down to what the screens keep. */
const known = (saved: Record<string, unknown>): Partial<Task> => Object.fromEntries(Object.entries(saved).filter(([k]) => KEPT.has(k)));

export const stale = (e: unknown): boolean => e instanceof ApiError && (e.status === 409 || e.status === 412);

/** What to tell a person whose change was refused. */
export const refusal = (e: unknown): string => (stale(e) ? "Someone else changed this task; it is shown as it stands now." : errorMessage(e));

/** Changes to one task go one after the other, each with the version the one before it left. */
const queue = new Map<string, Promise<unknown>>();

/**
 * Changes a task of the project's loaded tasks. The change shows at once; the server's answer
 * (which may differ: it works out Overdue, progress and the rest) replaces it; a refusal puts the
 * old values back and says why. `quiet` leaves the telling to the caller (changes made as a side
 * effect of another). `after` holds the change back until another one has been made, and drops it
 * (putting the old values back) if that one was refused.
 */
export function changeTask(qc: QueryClient, project: string, task: Task, patch: Partial<Task>, quiet = false, after?: Promise<boolean>): Promise<boolean> {
  const key = tasksKey(project);
  const apply = (change: Partial<Task>) => qc.setQueryData<TaskSet>(key, (d) => d && { ...d, rows: patched(d.rows, task.id, change) });
  const undo = () => apply(Object.fromEntries(Object.keys(patch).map((k) => [k, task[k as keyof Task] ?? null])) as Partial<Task>);
  apply(patch);
  const run = async (): Promise<boolean> => {
    if (after && !(await after)) {
      undo();
      return false;
    }
    // The latest version known: an earlier change to this task may have raised it.
    const current = qc.getQueryData<TaskSet>(key)?.rows.find((t) => t.id === task.id);
    try {
      const saved = await api.patch<Record<string, unknown>>(docPath("Task", task.id), patch, { ifMatch: current?.version ?? task.version });
      apply(known(saved));
      // The server follows the dates: a late task asked to be Open comes back Overdue. Say so.
      if (!quiet && patch.status === "Open" && saved.status === "Overdue") toast("It is past its expected end date, so it stays Overdue until that date moves.", "info");
      // The task's panel and page read the record itself: it has a new version and maybe new values.
      void qc.invalidateQueries({ queryKey: ["peek", "Task", task.id] });
      void qc.invalidateQueries({ queryKey: ["projects", "task", task.id] });
      return true;
    } catch (e) {
      undo();
      if (!quiet) toast(refusal(e), "error");
      void qc.invalidateQueries({ queryKey: key });
      return false;
    }
  };
  const next = (queue.get(task.id) ?? Promise.resolve()).then(run);
  queue.set(task.id, next);
  void next.finally(() => queue.get(task.id) === next && queue.delete(task.id));
  return next;
}

/** A new task in a project, at the foot of its status (a task without a rank comes last). */
export async function createTask(qc: QueryClient, project: string, subject: string, status: string): Promise<Task | null> {
  try {
    const made = await api.post<Record<string, unknown>>("/api/v1/Task", { subject, project, status }, { idempotencyKey: newKey() });
    const task = known(made) as Task;
    qc.setQueryData<TaskSet>(tasksKey(project), (d) => d && { rows: [...d.rows, task], total: d.total + 1 });
    return task;
  } catch (e) {
    toast(errorMessage(e), "error");
    return null;
  }
}

/** The address's search parameters, and a way to change some of them in one step (null removes). */
export function useQueryState(): [URLSearchParams, (change: Record<string, string | null>) => void] {
  const [sp, setSp] = useSearchParams();
  const set = useCallback(
    (change: Record<string, string | null>) =>
      setSp(
        (old) => {
          const next = new URLSearchParams(old);
          for (const [k, v] of Object.entries(change)) {
            if (v) next.set(k, v);
            else next.delete(k);
          }
          return next;
        },
        { replace: true },
      ),
    [setSp],
  );
  return [sp, set];
}

/** A person's name from their address, where the workspace's people are known. */
export function useNames(): (email: string | null | undefined) => string {
  const users = usePeople().data?.users;
  return useMemo(() => {
    const names = new Map((users ?? []).map((u) => [u.email.toLowerCase(), u.full_name]));
    return (email) => (email ? names.get(email.toLowerCase()) || email : "");
  }, [users]);
}
