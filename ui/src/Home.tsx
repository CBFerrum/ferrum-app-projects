// Projects' home: the open projects with how far along they are, and the signed-in person's open
// tasks, the soonest due first. A project opens in the project view (./Project.tsx).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { Link } from "react-router";
import { api } from "@ferrum/client";
import { Badge, Button, EmptyState, ErrorState, Spinner, statusTone, useLiveEntity, useShellTitle } from "@ferrum/kit";
import { can, useMe, useMetaIndex } from "@ferrum/records";
import { DONE, late, type Task } from "./plan";

export interface Project {
  id: string;
  project_name?: string | null;
  status?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  customer?: string | null;
  proj_priority?: string | null;
  proj_project_manager?: string | null;
  proj_percent_complete?: string | number | null;
  _titles?: Record<string, string>;
}

export const rows = <T,>(entity: string, query: Record<string, string | number>, signal?: AbortSignal) =>
  api.get<{ rows: T[]; total?: number }>(`/api/v1/${entity}`, { titles: "true", ...query }, signal);
export const today = () => new Date().toISOString().slice(0, 10);

export function Progress({ value }: { value: string | number | null | undefined }) {
  const pct = Math.max(0, Math.min(100, Math.round(Number(value ?? 0))));
  return (
    <span className="pj-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Complete">
      <span style={{ width: `${pct}%` }} />
      <small>{pct}%</small>
    </span>
  );
}

function Projects() {
  const q = useQuery({
    queryKey: ["projects", "open"],
    queryFn: ({ signal }) =>
      rows<Project>("Project", { filters: JSON.stringify([["status", "=", "Open"]]), sort: "end_date asc", limit: 100, fields: "project_name,status,start_date,end_date,customer,proj_priority,proj_project_manager,proj_percent_complete" }, signal),
  });
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data) return <Spinner label="Loading projects" />;
  if (!q.data.rows.length) {
    return (
      <EmptyState title="No open projects" icon="board">
        <Link to="e/Project/new">Start a project</Link>
      </EmptyState>
    );
  }
  return (
    <ul className="pj-projects">
      {q.data.rows.map((p) => (
        <li key={p.id}>
          <Link className="pj-project" to={`p/${p.id}`}>
            <span className="pj-project-name">{p.project_name}</span>
            <span className="faint">{[p._titles?.customer, p.end_date && `due ${p.end_date}`, p.proj_project_manager].filter(Boolean).join(" · ")}</span>
            <Progress value={p.proj_percent_complete} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function MyTasks({ me }: { me: string }) {
  const q = useQuery({
    queryKey: ["projects", "my-tasks", me],
    queryFn: ({ signal }) =>
      rows<Task & { project?: string; _titles?: Record<string, string> }>(
        "Task",
        { filters: JSON.stringify([["assigned_to.user", "=", me], ["status", "not in", DONE]]), sort: "exp_end_date asc", limit: 50, fields: "subject,status,priority,exp_end_date,project" },
        signal,
      ).then((r) => r.rows),
  });
  if (q.error) return <p className="muted">Your tasks cannot be shown.</p>;
  if (!q.data) return <Spinner small label="Loading your tasks" />;
  if (!q.data.length) return <p className="muted">Nothing open on your plate.</p>;
  const now = today();
  return (
    <ul className="stack">
      {q.data.map((t) => (
        <li key={t.id}>
          <Link to={`e/Task/${t.id}`}>{t.subject}</Link> <span className="faint">{t._titles?.project}</span> <Badge tone={statusTone(t.status)}>{t.status}</Badge>{" "}
          {t.exp_end_date && <span className={late(t, now) ? "pj-late" : "faint"}>due {t.exp_end_date}</span>}
        </li>
      ))}
    </ul>
  );
}

export function ProjectsHome() {
  useShellTitle("Projects");
  const me = useMe().data?.user.email;
  const meta = useMetaIndex().data;
  const project = meta?.entities.find((e) => e.name === "Project");
  const qc = useQueryClient();
  const refresh = useCallback(() => void qc.invalidateQueries({ queryKey: ["projects"] }), [qc]);
  useLiveEntity("Task", refresh);
  useLiveEntity("Project", refresh);
  if (meta && !(project && can(project.permissions, "read"))) {
    return (
      <EmptyState title="No projects for you" icon="alert">
        <p className="muted">Ask an administrator for a Projects role.</p>
      </EmptyState>
    );
  }
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">Projects</h1>
          <p className="page-sub">Open projects and how far along they are, and your tasks.</p>
        </div>
        {project && can(project.permissions, "create") && (
          <div className="page-actions">
            <Link to="e/Project/new">
              <Button variant="primary" icon="plus">
                New project
              </Button>
            </Link>
          </div>
        )}
      </div>
      <Projects />
      {me && (
        <section className="card" aria-labelledby="pj-mine">
          <div className="card-head">
            <h2 id="pj-mine">Your tasks</h2>
          </div>
          <div className="card-body">
            <MyTasks me={me} />
          </div>
        </section>
      )}
    </div>
  );
}
