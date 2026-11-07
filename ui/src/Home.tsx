// Projects' home: the open projects with how far along they are and what is late in them, and the
// signed-in person's soonest tasks (all of them are on My work). A project opens in the project view.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { Link } from "react-router";
import { todayIso, t as tr, isolate } from "@ferrum/client";
import { Badge, EmptyState, ErrorState, Spinner, statusTone, useLiveEntity, useShellTitle } from "@ferrum/kit";
import { can, useMe, useMetaIndex } from "@ferrum/records";
import { Due, PriorityFlag, Progress } from "./bits";
import { list, type Project } from "./data";
import { Nav } from "./Nav";
import { DONE, late, type Task } from "./plan";

function Projects() {
  const projects = useQuery({
    queryKey: ["projects", "open"],
    queryFn: ({ signal }) =>
      list<Project>("Project", { titles: true, filters: JSON.stringify([["status", "in", ["Open", "On Hold"]]]), sort: "end_date asc", limit: 100, fields: "project_name,status,start_date,end_date,customer,proj_priority,proj_project_manager,proj_percent_complete" }, signal),
  });
  // Late tasks by project, one request for all of them.
  const overdue = useQuery({
    queryKey: ["projects", "overdue"],
    queryFn: ({ signal }) => list<Task>("Task", { filters: JSON.stringify([["status", "=", "Overdue"]]), fields: "project", limit: 500 }, signal),
  });
  const lateBy = useMemo(() => {
    const n = new Map<string, number>();
    for (const t of overdue.data?.rows ?? []) if (t.project) n.set(t.project, (n.get(t.project) ?? 0) + 1);
    return n;
  }, [overdue.data]);
  if (projects.error) return <ErrorState error={projects.error} onRetry={() => void projects.refetch()} title={tr("The projects cannot be shown")} />;
  if (!projects.data) return <Spinner label={tr("Loading projects")} />;
  if (!projects.data.rows.length) {
    return (
      <EmptyState title={tr("No open projects")} icon="board">
        <Link to="e/Project/new">{tr("Start a project")}</Link>
      </EmptyState>
    );
  }
  return (
    <ul className="pj-projects" data-ferrum-nocard>
      {projects.data.rows.map((p) => (
        <li key={p.id}>
          <Link className="pj-project" to={`p/${p.id}`}>
            <span className="pj-project-top">
              <span className="pj-project-name">{isolate(p.project_name ?? "")}</span>
              {p.status === "On Hold" && <Badge tone="amber">{tr("On hold")}</Badge>}
              <PriorityFlag priority={p.proj_priority} />
            </span>
            <span className="faint">{isolate([p._titles?.customer, p.end_date && `due ${p.end_date}`, p.proj_project_manager].filter(Boolean).join(" · "))}</span>
            <span className="pj-project-foot">
              <Progress value={p.proj_percent_complete} />
              {(lateBy.get(p.id) ?? 0) > 0 && <span className="pj-late">{tr("{lateBy} late", { lateBy: lateBy.get(p.id) ?? "" })}</span>}
            </span>
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
      list<Task>("Task", { titles: true, filters: JSON.stringify([["assigned_to.user", "=", me], ["status", "not in", DONE]]), sort: "exp_end_date asc", limit: 8, count: true, fields: "number,subject,status,priority,exp_end_date,project" }, signal),
  });
  if (q.error) return <p className="muted">{tr("Your tasks cannot be shown.")}</p>;
  if (!q.data) return <Spinner small label={tr("Loading your tasks")} />;
  if (!q.data.rows.length) return <p className="muted">{tr("Nothing open on your plate.")}</p>;
  const now = todayIso();
  return (
    <>
      <ul className="pj-mine" data-ferrum-nocard>
        {q.data.rows.map((t) => (
          <li key={t.id}>
            <Link to={`t/${t.id}`}>{isolate(t.subject ?? "")}</Link>
            <span className="faint pj-mine-project">{isolate(t._titles?.project ?? "")}</span>
            <PriorityFlag priority={t.priority} />
            <Badge tone={statusTone(t.status)}>{isolate(t.status ?? "")}</Badge>
            <Due day={t.exp_end_date} late={late(t, now)} />
          </li>
        ))}
      </ul>
      <p>
        <Link to="my">{(q.data.total ?? 0) > q.data.rows.length ? tr("All {total} of your tasks", { total: String(q.data.total) }) : tr("Everything on your plate")}</Link>
      </p>
    </>
  );
}

export function ProjectsHome() {
  useShellTitle(tr("Projects"));
  const me = useMe().data?.user.email;
  const meta = useMetaIndex().data;
  const project = meta?.entities.find((e) => e.name === "Project");
  const qc = useQueryClient();
  const refresh = useCallback(() => void qc.invalidateQueries({ queryKey: ["projects"] }), [qc]);
  useLiveEntity("Task", refresh);
  useLiveEntity("Project", refresh);
  if (meta && !(project && can(project.permissions, "read"))) {
    return (
      <EmptyState title={tr("No projects for you")} icon="alert">
        <p className="muted">{tr("Ask an administrator for a Projects role.")}</p>
      </EmptyState>
    );
  }
  return (
    <div className="pj-page">
      <header className="pj-head-row">
        <Nav />
        {project && can(project.permissions, "create") && (
          <Link className="btn btn-primary btn-md" to="e/Project/new">
            {tr("New project")}
          </Link>
        )}
      </header>
      <Projects />
      {me && (
        <section className="card" aria-labelledby="pj-mine">
          <div className="card-head">
            <h2 id="pj-mine">{tr("Your soonest tasks")}</h2>
          </div>
          <div className="card-body">
            <MyTasks me={me} />
          </div>
        </section>
      )}
    </div>
  );
}
