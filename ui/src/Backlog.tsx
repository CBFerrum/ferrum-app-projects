// A project's backlog: its active sprint, its planned sprints and the backlog (open tasks in no sprint), each with
// its tasks, points and people. A task moves between them and up the backlog from its row's menu, its points are
// typed in the row, and a sprint is started or closed from its head (closing says where the open tasks go). Every
// change is an operation the server already offers: a task's save, or a sprint's action.

import { useQueryClient } from "@tanstack/react-query";
import { Ellipsis } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { Link } from "react-router";
import { api, errorMessage, newKey, t as tr, isolate } from "@ferrum/client";
import { Badge, EmptyState, ErrorState, ListSkeleton, statusTone, toast, useLiveEntity } from "@ferrum/kit";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@ferrum/kit/primitives";
import { can, useMetaIndex } from "@ferrum/records";
import { backlogModel, placeAt, type Section, type Sprint } from "./sprints";
import { Avatars } from "./bits";
import { changeTask, type Project, sprintsKey, tasksKey, type TaskSet, useNames, useSprints } from "./data";
import { shortDay } from "./days";
import { assignees, num, TASK_TONES, type Task } from "./plan";

/** What a person may do here: write tasks (move, points), write sprints (start, close), plan sprints. */
interface Rights {
  tasks: boolean;
  sprints: boolean;
  plan: boolean;
}

export function Backlog({ project, set, onOpen }: { project: Project; set: TaskSet; open: string | null; onOpen: (id: string | null) => void }) {
  const qc = useQueryClient();
  const names = useNames();
  const index = useMetaIndex().data?.entities;
  const sprints = useSprints(project.id);
  useLiveEntity("Sprint", useCallback(() => void qc.invalidateQueries({ queryKey: sprintsKey(project.id) }), [qc, project.id]));
  const closed = project.status === "Completed" || project.status === "Cancelled";
  const meta = (name: string) => index?.find((e) => e.name === name);
  const sprintMeta = meta("Sprint");
  const taskMeta = meta("Task");
  const rights: Rights = {
    tasks: !closed && !!taskMeta && can(taskMeta.permissions, "write") && !!sprintMeta && can(sprintMeta.permissions, "write"),
    sprints: !closed && !!sprintMeta && can(sprintMeta.permissions, "write"),
    plan: !closed && !!sprintMeta && can(sprintMeta.permissions, "create"),
  };

  if (sprints.error) return <ErrorState error={sprints.error} onRetry={() => void sprints.refetch()} title={tr("The sprints cannot be shown")} />;
  if (!sprints.data) return <ListSkeleton rows={6} />;
  const { sections } = backlogModel(set.rows, sprints.data);
  const active = sprints.data.some((s) => s.state === "Active");
  const planLink = rights.plan && (
    <Link className="btn btn-md" to={`/e/Sprint/new?project=${project.id}`}>
      {tr("Plan a sprint")}
    </Link>
  );
  if (sections.length === 1 && !sections[0].tasks.length) {
    return (
      <EmptyState title={tr("Nothing is planned yet")}>
        {planLink}
      </EmptyState>
    );
  }
  const changed = () => {
    void qc.invalidateQueries({ queryKey: sprintsKey(project.id) });
    void qc.invalidateQueries({ queryKey: tasksKey(project.id) });
  };
  return (
    <div className="pj-backlog">
      {planLink && <div className="pj-tools">{planLink}</div>}
      {sections.map((s) => (
        <SectionView key={s.sprint?.id ?? "backlog"} section={s} sections={sections} project={project} rights={rights} active={active} names={names} onOpen={onOpen} onChanged={changed} />
      ))}
    </div>
  );
}

function SectionView({ section: s, sections, project, rights, active, names, onOpen, onChanged }: {
  section: Section;
  sections: Section[];
  project: Project;
  rights: Rights;
  active: boolean;
  names: (email: string) => string;
  onOpen: (id: string | null) => void;
  onChanged: () => void;
}) {
  const heading = `pj-sec-${s.sprint?.id ?? "backlog"}`;
  return (
    <section className="pj-sprint" aria-labelledby={heading}>
      <header className="pj-sprint-head">
        <h2 id={heading}>{s.sprint ? isolate(s.sprint.sprint_name) : tr("Backlog")}</h2>
        {s.sprint && <Badge tone={statusTone(s.sprint.state, { Active: "blue", Planned: "neutral", Closed: "green" })}>{isolate(s.sprint.state)}</Badge>}
        <span className="faint">
          {isolate(
            [s.sprint ? `${shortDay(s.sprint.start_date)} – ${shortDay(s.sprint.end_date)}` : null, tr("{points} points", { points: s.points }), tr("{n} tasks", { n: s.tasks.length })]
              .filter(Boolean)
              .join(" · "),
          )}
        </span>
        {s.sprint && rights.sprints && <SprintButtons sprint={s.sprint} sections={sections} active={active} onChanged={onChanged} />}
        {s.sprint && (
          <Link className="link-btn" to={`/e/Sprint/${s.sprint.id}`}>
            {tr("Edit")}
          </Link>
        )}
      </header>
      {s.sprint?.goal && <p className="pj-sprint-goal">{isolate(s.sprint.goal)}</p>}
      {s.tasks.length ? (
        <ul className="pj-backlog-rows">
          {s.tasks.map((t) => (
            <Row key={t.id} task={t} section={s} sections={sections} project={project} rights={rights} names={names} onOpen={onOpen} />
          ))}
        </ul>
      ) : (
        <p className="muted">{s.sprint ? tr("No tasks in this sprint yet") : tr("The backlog is empty")}</p>
      )}
    </section>
  );
}

function Row({ task: t, section, sections, project, rights, names, onOpen }: {
  task: Task;
  section: Section;
  sections: Section[];
  project: Project;
  rights: Rights;
  names: (email: string) => string;
  onOpen: (id: string | null) => void;
}) {
  const qc = useQueryClient();
  const label = t.number ?? t.subject ?? "";
  const move = (patch: Partial<Task>, of: Task = t) => void changeTask(qc, project.id, of, patch);
  const moveIn = (where: "top" | "up" | "down") => {
    for (const c of placeAt(section.tasks, t.id, where) ?? []) {
      const of = section.tasks.find((x) => x.id === c.id);
      if (of) move({ backlog_rank: c.backlog_rank }, of);
    }
  };
  const [points, setPoints] = useState(t.story_points == null ? "" : String(num(t.story_points)));
  const savePoints = () => {
    const now = points.trim();
    if (now === (t.story_points == null ? "" : String(num(t.story_points)))) return;
    move({ story_points: now === "" ? null : now });
  };
  return (
    <li className="pj-backlog-row">
      <span className="faint">{isolate(t.number ?? "")}</span>
      <button type="button" className="link-btn pj-backlog-subject" onClick={() => onOpen(t.id)}>
        {isolate(t.subject ?? "")}
      </button>
      <Badge tone={statusTone(t.status ?? "Open", TASK_TONES)}>{isolate(t.status ?? "Open")}</Badge>
      {rights.tasks ? (
        <input
          className="input pj-points"
          inputMode="decimal"
          aria-label={tr("Points for {value}", { value: label })}
          value={points}
          onChange={(e) => setPoints(e.target.value)}
          onBlur={savePoints}
          onKeyDown={(e) => e.key === "Enter" && savePoints()}
        />
      ) : (
        t.story_points != null && <span className="faint">{tr("{points} points", { points: num(t.story_points) })}</span>
      )}
      <Avatars emails={assignees(t)} names={names} />
      {rights.tasks && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="pj-card-menu" aria-label={tr("Move {value}", { value: label })}>
              <Ellipsis size={15} aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {sections
              .filter((o) => o !== section)
              .map((o) =>
                o.sprint ? (
                  <DropdownMenuItem key={o.sprint.id} onSelect={() => move({ sprint: o.sprint?.id ?? null })}>
                    {tr("Move to {name}", { name: o.sprint.sprint_name })}
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem key="backlog" onSelect={() => move({ sprint: null })}>
                    {tr("Move to the backlog")}
                  </DropdownMenuItem>
                ),
              )}
            {!section.sprint && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => moveIn("top")}>{tr("To the top")}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => moveIn("up")}>{tr("Up")}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => moveIn("down")}>{tr("Down")}</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
}

/** Start a planned sprint (when none is active), or close the active one saying where its open tasks go. One key per
 *  attempt, kept for a retry, so a double press starts or closes once. */
function SprintButtons({ sprint, sections, active, onChanged }: { sprint: Sprint; sections: Section[]; active: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [target, setTarget] = useState("");
  const key = useRef(newKey());
  const opener = useRef<HTMLButtonElement>(null);
  const run = async (action: "start" | "close", body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const done = await api.post<{ completed_tasks?: number; carried_over?: number }>(`/api/v1/Sprint/${sprint.id}/actions/${action}`, body, { idempotencyKey: key.current });
      key.current = newKey();
      toast(action === "start" ? tr("{name} started", { name: sprint.sprint_name }) : tr("{name} closed: {done} done, {moved} moved on", { name: sprint.sprint_name, done: done.completed_tasks ?? 0, moved: done.carried_over ?? 0 }));
      setClosing(false);
      onChanged();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };
  if (sprint.state === "Planned") {
    return active ? null : (
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run("start", {})}>
        {tr("Start sprint")}
      </button>
    );
  }
  if (sprint.state !== "Active") return null;
  if (!closing) {
    return (
      <button type="button" className="btn btn-sm" ref={opener} onClick={() => setClosing(true)}>
        {tr("Close sprint…")}
      </button>
    );
  }
  const planned = sections.flatMap((s) => (s.sprint && s.sprint.state === "Planned" ? [s.sprint] : []));
  return (
    <form
      className="pj-close-sprint"
      onSubmit={(e) => {
        e.preventDefault();
        void run("close", target ? { move_open_to: target } : {});
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setClosing(false);
          requestAnimationFrame(() => opener.current?.focus());
        }
      }}
    >
      <label>
        {tr("Open tasks go to")}{" "}
        <select className="select" autoFocus value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">{tr("The backlog")}</option>
          {planned.map((p) => (
            <option key={p.id} value={p.id}>
              {isolate(p.sprint_name)}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
        {tr("Close sprint")}
      </button>
    </form>
  );
}
