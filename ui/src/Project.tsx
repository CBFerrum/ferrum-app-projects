// A project as its team works it: the board (tasks by status, moved with their menu, added in
// place), the timeline (each task's expected dates as a bar, milestones as marks) and the time
// logged on it (the timesheet summary for the project).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useCallback, useState } from "react";
import { Link, useParams } from "react-router";
import { api, ApiError, errorMessage } from "@ferrum/client";
import { Badge, Button, EmptyState, ErrorState, PageLoading, Spinner, statusTone, TabPanel, Tabs, toast, useLiveEntity, useShellTitle } from "@ferrum/kit";
import { type Project, Progress, rows, today } from "./Home";
import { assignees, board, COLUMNS, late, type Task, timeline } from "./plan";

const TASK_FIELDS = "number,subject,status,priority,exp_start_date,exp_end_date,progress,is_milestone,parent_task,assigned_to";
const initials = (email: string) => email.split("@")[0].split(/[._-]/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");

function Card({ t, onMove }: { t: Task; onMove: (t: Task, status: string) => void }) {
  return (
    <li className="pj-card">
      <Link to={`/e/Task/${t.id}`} className="pj-card-subject">
        {t.is_milestone && <span aria-label="Milestone">◆ </span>}
        {t.subject}
      </Link>
      <span className="pj-card-meta">
        {t.priority && t.priority !== "Medium" && <Badge tone={t.priority === "Urgent" ? "red" : t.priority === "High" ? "amber" : "neutral"}>{t.priority}</Badge>}
        {t.exp_end_date && <span className={late(t, today()) ? "pj-late" : "faint"}>due {t.exp_end_date}</span>}
        {assignees(t).map((a) => (
          <span key={a} className="pj-assignee" title={a}>
            {initials(a)}
          </span>
        ))}
      </span>
      <select className="input pj-move" aria-label={`Move “${t.subject}”`} value={t.status ?? "Open"} onChange={(e) => onMove(t, e.target.value)}>
        {[...COLUMNS, "Cancelled"].map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
    </li>
  );
}

function Board({ project, tasks }: { project: Project; tasks: Task[] }) {
  const qc = useQueryClient();
  const [subject, setSubject] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["projects", "tasks", project.id] });
  const move = async (t: Task, status: string) => {
    try {
      await api.patch(`/api/v1/Task/${t.id}`, { status });
      toast(`“${t.subject}”: ${status}`);
    } catch (err) {
      toast(errorMessage(err), "error");
    }
    await refresh();
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!subject.trim()) return;
    setBusy(true);
    try {
      await api.post("/api/v1/Task", { subject: subject.trim(), project: project.id, status: "Open" }, { idempotencyKey: crypto.randomUUID() });
      setSubject("");
      await refresh();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <form className="row pj-add" onSubmit={add}>
        <input className="input" placeholder="Add a task" aria-label="New task" value={subject} onChange={(e) => setSubject(e.target.value)} />
        <Button type="submit" icon="plus" loading={busy} disabled={!subject.trim()}>
          Add
        </Button>
      </form>
      <div className="pj-board" role="list" aria-label="Tasks by status" data-ferrum-nocard>
        {board(tasks).map((c) => (
          <section key={c.status} className="pj-column" role="listitem" aria-label={c.status}>
            <div className="pj-column-head">
              <Badge tone={statusTone(c.status)}>{c.status}</Badge>
              <span className="faint">{c.tasks.length}</span>
            </div>
            <ul className="pj-cards">
              {c.tasks.map((t) => (
                <Card key={t.id} t={t} onMove={(task, s) => void move(task, s)} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function Timeline({ project, tasks }: { project: Project; tasks: Task[] }) {
  const tl = timeline(
    tasks.filter((t) => t.status !== "Cancelled"),
    project.start_date,
    project.end_date,
  );
  if (!tl.days) {
    return (
      <EmptyState title="Nothing to place on a timeline" icon="timeline">
        <p className="muted">Give the project or its tasks expected dates.</p>
      </EmptyState>
    );
  }
  const now = today();
  const todayAt = now >= tl.start && now <= tl.end ? (Date.parse(`${now}T00:00:00Z`) - Date.parse(`${tl.start}T00:00:00Z`)) / 86_400_000 / tl.days : null;
  const pct = (f: number) => `${(f * 100).toFixed(3)}%`;
  return (
    <div className="stack">
      <p className="faint">
        {tl.start} – {tl.end} · {tl.days} days
      </p>
      <div className="pj-timeline">
        <div className="pj-months" aria-hidden="true">
          {tl.months.map((m) => (
            <span key={m.label} style={{ left: pct(m.left) }}>
              {m.label}
            </span>
          ))}
        </div>
        <ul className="pj-bars" data-ferrum-nocard>
          {tl.bars.map((b) => (
            <li key={b.task.id}>
              <Link to={`/e/Task/${b.task.id}`} className="pj-bar-label">
                {b.task.subject}
              </Link>
              <span className="pj-track">
                {todayAt !== null && <span className="pj-today" style={{ left: pct(todayAt) }} aria-hidden="true" />}
                <span
                  className={`pj-bar${b.task.is_milestone ? " pj-milestone" : ""}${late(b.task, now) ? " pj-bar-late" : ""}${b.task.status === "Completed" ? " pj-bar-done" : ""}`}
                  style={{ left: pct(b.left), width: b.task.is_milestone ? undefined : pct(b.width) }}
                  title={`${b.task.subject}: ${b.task.exp_start_date ?? ""} – ${b.task.exp_end_date ?? ""} (${b.task.status})`}
                />
              </span>
            </li>
          ))}
        </ul>
      </div>
      {tl.unscheduled.length > 0 && (
        <p className="muted">
          Not scheduled: {tl.unscheduled.map((t, i) => (
            <span key={t.id}>
              {i > 0 && ", "}
              <Link to={`/e/Task/${t.id}`}>{t.subject}</Link>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

interface Report {
  columns: { name: string; label: string; type: string }[];
  rows: Record<string, unknown>[];
}

function Time({ project }: { project: Project }) {
  const q = useQuery({
    queryKey: ["projects", "time", project.id],
    queryFn: ({ signal }) => api.get<Report>("/api/reports/timesheet_summary", { project: project.id }, signal),
  });
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} title="The time logged cannot be shown" />;
  if (!q.data) return <Spinner label="Loading the time logged" />;
  if (!q.data.rows.length) {
    return (
      <EmptyState title="No time logged yet" icon="calendar">
        <Link to={`/e/Timesheet/new?project=${project.id}`}>Log time</Link>
      </EmptyState>
    );
  }
  return (
    <div className="stack">
      <div className="pj-table-wrap">
        <table className="pj-table">
          <thead>
            <tr>
              {q.data.columns.map((c) => (
                <th key={c.name} className={["int", "decimal", "currency", "percent"].includes(c.type) ? "num" : undefined}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {q.data.rows.map((r, i) => (
              <tr key={i}>
                {q.data!.columns.map((c) => (
                  <td key={c.name} className={["int", "decimal", "currency", "percent"].includes(c.type) ? "num" : undefined}>
                    {String(r[c.name] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        <Link to={`/r/timesheet_summary?project=${project.id}`}>The full timesheet summary</Link> · <Link to={`/e/Timesheet/new?project=${project.id}`}>Log time</Link>
      </p>
    </div>
  );
}

export function ProjectPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const [tab, setTab] = useState("board");
  const project = useQuery({
    queryKey: ["projects", "project", id],
    queryFn: ({ signal }) => api.get<Project>(`/api/v1/Project/${id}`, undefined, signal),
    enabled: !!id,
  });
  const tasks = useQuery({
    queryKey: ["projects", "tasks", id],
    queryFn: ({ signal }) => rows<Task>("Task", { filters: JSON.stringify([["project", "=", id]]), sort: "exp_start_date asc", limit: 500, fields: TASK_FIELDS }, signal).then((r) => r.rows),
    enabled: !!id,
  });
  useShellTitle(project.data?.project_name);
  useLiveEntity(
    "Task",
    useCallback(() => void qc.invalidateQueries({ queryKey: ["projects", "tasks", id] }), [qc, id]),
  );
  if (project.error) {
    if (project.error instanceof ApiError && project.error.status === 404) {
      return (
        <EmptyState title="This project no longer exists">
          <Link to="/">Back to projects</Link>
        </EmptyState>
      );
    }
    return <ErrorState error={project.error} onRetry={() => void project.refetch()} />;
  }
  if (!project.data) return <PageLoading label="Loading the project" />;
  const p = project.data;
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <p className="page-sub">
            <Link to="/">Projects</Link>
          </p>
          <h1 className="page-title">{p.project_name}</h1>
          <p className="row pj-facts">
            <Badge tone={statusTone(p.status)}>{p.status}</Badge>
            {p.proj_priority && p.proj_priority !== "Medium" && <Badge tone="amber">{p.proj_priority}</Badge>}
            <span className="faint">{[p._titles?.customer, p.start_date && p.end_date ? `${p.start_date} – ${p.end_date}` : null, p.proj_project_manager].filter(Boolean).join(" · ")}</span>
            <Progress value={p.proj_percent_complete} />
          </p>
        </div>
        <div className="page-actions">
          <Link to={`/e/Project/${p.id}`}>
            <Button>Edit the project</Button>
          </Link>
        </div>
      </div>
      <Tabs
        id="pj"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "board", label: "Board" },
          { id: "timeline", label: "Timeline" },
          { id: "time", label: "Time" },
        ]}
      />
      <TabPanel id="pj" tab={tab}>
        {tasks.error ? (
          <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} />
        ) : !tasks.data ? (
          <Spinner label="Loading tasks" />
        ) : tab === "board" ? (
          <Board project={p} tasks={tasks.data} />
        ) : tab === "timeline" ? (
          <Timeline project={p} tasks={tasks.data} />
        ) : (
          <Time project={p} />
        )}
      </TabPanel>
    </div>
  );
}
