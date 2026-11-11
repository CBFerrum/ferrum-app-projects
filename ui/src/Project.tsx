// A project as its team works it: how it stands (progress, hours, money, risks), then the board,
// the timeline and the time logged on it. A task opens in a panel beside the board or the
// timeline (`?task=`); the tab, the filters and the zoom are in the address, so a link to the
// view is a link to what the sender saw.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, type ReactNode, Suspense, useCallback, useMemo } from "react";
import { Link, useParams } from "react-router";
import { api, ApiError, formatDecimal, todayIso, t as tr, isolate } from "@ferrum/client";
import { Badge, EmptyState, ErrorState, ListSkeleton, PageLoading, statusTone, TabPanel, Tabs, useLiveEntity, useShellTitle } from "@ferrum/kit";
import { Progress } from "./bits";
import { list, loadTasks, type Project, tasksKey, useQueryState } from "./data";
import { addDays } from "./days";
import { late, num, PROJECT_TONES } from "./plan";
import { TaskPanel } from "./TaskPanel";

const Board = lazy(() => import("./Board").then((m) => ({ default: m.Board })));
const Timeline = lazy(() => import("./Timeline").then((m) => ({ default: m.Timeline })));

const TABS = [
  { id: "board", get label() { return tr("Board"); } },
  { id: "timeline", get label() { return tr("Timeline"); } },
  { id: "time", get label() { return tr("Time"); } },
];

/** An amount in the project's currency, whole units (these are for comparing). */
export function money(value: unknown, code?: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  try {
    return new Intl.NumberFormat(undefined, code && /^[A-Z]{3}$/.test(code) ? { style: "currency", currency: code, maximumFractionDigits: 0 } : { maximumFractionDigits: 0 }).format(n);
  } catch {
    return formatDecimal(String(n), 0);
  }
}

function Tile({ label, to, children }: { label: string; to?: string; children: ReactNode }) {
  const inner = (
    <>
      <span className="pj-tile-label">{isolate(label)}</span>
      <span className="pj-tile-value">{children}</span>
    </>
  );
  return to ? (
    <Link className="pj-tile" to={to}>
      {inner}
    </Link>
  ) : (
    <div className="pj-tile">{inner}</div>
  );
}

/** How the project stands in one strip: progress, hours against the estimate, money, what is open. */
function Overview({ project: p, open, overdue }: { project: Project; open: number; overdue: number }) {
  const code = p._titles?.currency;
  const watch = useQuery({
    queryKey: ["projects", "watch", p.id],
    queryFn: async () => {
      // A person who may not read one of these gets no tile for it.
      const count = (entity: string, filters: unknown[]) => list<unknown>(entity, { filters: JSON.stringify(filters), fields: "id", limit: 1, count: true }).then((r) => r.total ?? 0).catch(() => null);
      const [risks, issues, changes] = await Promise.all([
        count("ProjectRisk", [["project", "=", p.id], ["status", "in", ["Open", "Mitigating"]]]),
        count("ProjectIssue", [["project", "=", p.id], ["status", "in", ["Open", "In Progress"]]]),
        count("ChangeRequest", [["project", "=", p.id], ["docstatus", "=", 1], ["decision", "=", "Pending"]]),
      ]);
      return { risks, issues, changes };
    },
  });
  const hours = num(p.proj_actual_hours);
  const estimate = num(p.proj_estimated_hours);
  const budget = num(p.budget) || num(p.proj_estimated_cost);
  const cost = p.proj_costing_amount;
  const billed = p.proj_billed_amount;
  const billable = num(p.proj_contract_value) || num(p.proj_billable_amount);
  return (
    <section className="pj-tiles" aria-label={tr("How the project stands")}>
      <Tile label={tr("Complete")}>
        <Progress value={p.proj_percent_complete} />
      </Tile>
      <Tile label={tr("Tasks")}>
        {tr("{open} open", { open })}
        {overdue > 0 && <span className="pj-late"> {tr("· {overdue} overdue", { overdue })}</span>}
      </Tile>
      {(hours > 0 || estimate > 0) && (
        <Tile label={tr("Hours")} to={`/r/timesheet_summary?project=${p.id}`}>
          <span className={estimate > 0 && hours > estimate ? "pj-late" : undefined}>{isolate(formatDecimal(String(hours), 1))} h</span>
          {estimate > 0 && <span className="faint"> {tr("of {value} h", { value: formatDecimal(String(estimate), 0) })}</span>}
        </Tile>
      )}
      {cost != null && (budget > 0 || num(cost) > 0) && (
        <Tile label={tr("Cost so far")}>
          <span className={budget > 0 && num(cost) > budget ? "pj-late" : undefined}>{isolate(money(cost, code))}</span>
          {budget > 0 && <span className="faint"> {tr("of {budget}", { budget: money(budget, code) })}</span>}
        </Tile>
      )}
      {billed != null && (num(billed) > 0 || billable > 0) && (
        <Tile label={tr("Billed")}>
          {isolate(money(billed, code))}
          {billable > 0 && <span className="faint"> {tr("of {billable}", { billable: money(billable, code) })}</span>}
        </Tile>
      )}
      {watch.data?.risks != null && (
        <Tile label={tr("Open risks")} to={`/e/ProjectRisk?f.project=${p.id}`}>
          {watch.data.risks}
        </Tile>
      )}
      {watch.data?.issues != null && (
        <Tile label={tr("Open issues")} to={`/e/ProjectIssue?f.project=${p.id}`}>
          {watch.data.issues}
        </Tile>
      )}
      {watch.data?.changes != null && watch.data.changes > 0 && (
        <Tile label={tr("Changes to decide")} to={`/e/ChangeRequest?f.project=${p.id}&f.decision=Pending`}>
          {watch.data.changes}
        </Tile>
      )}
    </section>
  );
}

interface Report {
  columns: { name: string; label: string; type: string }[];
  rows: Record<string, unknown>[];
  totals?: Record<string, unknown>;
}

const NUMBER = ["int", "decimal", "currency", "percent", "float"];

/** The time logged on the project, by person and activity: the timesheet summary, over the project's whole life. */
function Time({ project }: { project: Project }) {
  const q = useQuery({
    queryKey: ["projects", "time", project.id],
    queryFn: ({ signal }) => api.get<Report>("/api/reports/timesheet_summary", { company: project.company, project: project.id, from_date: "2000-01-01", to_date: addDays(todayIso(), 366) }, signal),
  });
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} title={tr("The time logged cannot be shown")} />;
  if (!q.data) return <ListSkeleton rows={5} />;
  const logTime = (
    <Link className="btn btn-primary btn-md" to={`/e/Timesheet/new?project=${project.id}`}>
      {tr("Log time")}
    </Link>
  );
  if (!q.data.rows.length) {
    return (
      <EmptyState title={tr("No time logged yet")} icon="calendar">
        {logTime}
      </EmptyState>
    );
  }
  const { columns, rows, totals } = q.data;
  return (
    <div className="stack">
      <div className="pj-table-wrap">
        <table className="pj-table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.name} className={NUMBER.includes(c.type) ? "num" : undefined}>
                  {isolate(c.label)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.name} className={NUMBER.includes(c.type) ? "num" : undefined}>
                    {isolate(String(r[c.name] ?? ""))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {totals && (
            <tfoot>
              <tr>
                {columns.map((c, i) => (
                  <td key={c.name} className={NUMBER.includes(c.type) ? "num" : undefined}>
                    {i === 0 ? tr("Total") : String(totals[c.name] ?? "")}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <p className="row">
        {logTime}
        <Link className="btn btn-md" to={`/r/timesheet_summary?project=${project.id}`}>
          {tr("The full timesheet summary")}
        </Link>
      </p>
    </div>
  );
}

/** Another project is another page: what was typed or chosen for one does not carry over. */
export function ProjectPage() {
  const { id = "" } = useParams();
  return <ProjectView key={id} id={id} />;
}

function ProjectView({ id }: { id: string }) {
  const qc = useQueryClient();
  const [sp, setQuery] = useQueryState();
  const asked = sp.get("tab");
  const tab = TABS.some((t) => t.id === asked) ? (asked as string) : "board";
  const task = tab === "time" ? null : sp.get("task");
  const project = useQuery({
    queryKey: ["projects", "project", id],
    queryFn: ({ signal }) => api.get<Project>(`/api/v1/Project/${id}`, { titles: true }, signal),
    enabled: !!id,
  });
  const tasks = useQuery({ queryKey: tasksKey(id), queryFn: ({ signal }) => loadTasks(id, signal), enabled: !!id });
  useShellTitle(project.data?.project_name);
  useLiveEntity("Task", useCallback(() => void qc.invalidateQueries({ queryKey: tasksKey(id) }), [qc, id]));
  useLiveEntity("Project", useCallback((e) => void (e.id === id && qc.invalidateQueries({ queryKey: ["projects", "project", id] })), [qc, id]));

  const day = todayIso();
  const counts = useMemo(() => {
    const rows = tasks.data?.rows ?? [];
    return { open: rows.filter((t) => t.status !== "Completed" && t.status !== "Cancelled").length, overdue: rows.filter((t) => late(t, day)).length };
  }, [tasks.data, day]);
  const open = useCallback((next: string | null) => setQuery({ task: next }), [setQuery]);

  if (project.error) {
    if (project.error instanceof ApiError && project.error.status === 404) {
      return (
        <EmptyState title={tr("This project no longer exists")}>
          <Link to="/">{tr("Back to projects")}</Link>
        </EmptyState>
      );
    }
    return <ErrorState error={project.error} onRetry={() => void project.refetch()} />;
  }
  if (!project.data) return <PageLoading label={tr("Loading the project")} />;
  const p = project.data;
  return (
    <div className="pj-page">
      <div className="page-head">
        <div>
          <p className="crumbs">
            <Link to="/">{tr("Projects")}</Link>
          </p>
          <h1 className="page-title">{isolate(p.project_name ?? "")}</h1>
          <p className="row pj-facts">
            <Badge tone={statusTone(p.status, PROJECT_TONES)}>{isolate(p.status ?? "")}</Badge>
            {p.proj_priority && p.proj_priority !== "Medium" && <Badge tone="amber">{isolate(p.proj_priority)}</Badge>}
            <span className="faint">{isolate([p._titles?.customer, p.start_date && p.end_date ? `${p.start_date} – ${p.end_date}` : null, p.proj_project_manager].filter(Boolean).join(" · "))}</span>
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn btn-md" to={`/e/Project/${p.id}`}>
            {tr("Edit the project")}
          </Link>
          {p.status !== "Completed" && p.status !== "Cancelled" && (
            <Link className="btn btn-primary btn-md" to={`/e/Task/new?project=${p.id}`}>
              {tr("New task")}
            </Link>
          )}
        </div>
      </div>
      <Overview project={p} open={counts.open} overdue={counts.overdue} />
      <Tabs id="pj" value={tab} onChange={(t) => setQuery({ tab: t === "board" ? null : t, task: null })} tabs={TABS} />
      <div className="pj-split" data-panel={task ? "" : undefined}>
        <div className="pj-main">
          <TabPanel id="pj" tab={tab}>
            {tab === "time" ? (
              <Time project={p} />
            ) : tasks.error ? (
              <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} title={tr("The tasks cannot be shown")} />
            ) : !tasks.data ? (
              <ListSkeleton rows={8} />
            ) : (
              <Suspense fallback={<ListSkeleton rows={8} />}>
                {tab === "board" ? <Board project={p} set={tasks.data} open={task} onOpen={open} /> : <Timeline project={p} set={tasks.data} open={task} onOpen={open} />}
              </Suspense>
            )}
          </TabPanel>
        </div>
        {task && tasks.data && <TaskPanel id={task} project={id} tasks={tasks.data.rows} onOpen={open} onClose={() => open(null)} />}
      </div>
    </div>
  );
}
