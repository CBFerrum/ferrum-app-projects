// What is on someone's plate across every project: their open tasks by when they fall due (or by
// project), what that comes to in hours, what they are planned for this week against what they
// logged, and a tick to be done with a task. A manager can look at anyone's.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { Link } from "react-router";
import { api, docPath, todayIso } from "@ferrum/client";
import { Badge, EmptyState, ErrorState, Icon, Spinner, toast, useLiveEntity, useShellTitle } from "@ferrum/kit";
import { can, useMe, useMetaIndex, usePeople } from "@ferrum/records";
import { Due, PriorityFlag } from "./bits";
import { list, refusal, useQueryState } from "./data";
import { addDays, shortDay, weekStart } from "./days";
import { Nav } from "./Nav";
import { CHOOSABLE, DONE, hoursLeft, late, patched, type Task } from "./plan";
import { byHorizon, byProject, plate } from "./plate";
import { type Allocation, CAPACITY, hoursIn, hoursText, weekEnd } from "./workload";

const FIELDS = "number,subject,project,status,priority,exp_start_date,exp_end_date,expected_hours,actual_hours,progress,is_milestone,parent_task,version";

interface Loaded {
  rows: Task[];
  total: number;
}

function Row({ task, today, writable, onPatch }: { task: Task; today: string; writable: boolean; onPatch: (t: Task, patch: Partial<Task>, gone?: boolean) => void }) {
  const isLate = late(task, today);
  const left = hoursLeft(task);
  // Pushed on from the later of its due date and today.
  const push = (days: number) => onPatch(task, { exp_end_date: addDays(task.exp_end_date && task.exp_end_date > today ? task.exp_end_date : today, days) });
  return (
    <li className="pj-row" data-late={isLate || undefined}>
      <button type="button" className="pj-tick" disabled={!writable} aria-label={`Done: ${task.subject}`} onClick={() => onPatch(task, { status: "Completed" }, true)}>
        <Icon name="check" size={12} />
      </button>
      <div className="pj-row-body">
        <Link to={`/t/${task.id}`} className="pj-row-title">
          {task.is_milestone && <span aria-label="Milestone">◆ </span>}
          {task.subject}
        </Link>
        <div className="faint pj-row-sub">
          {task.number}
          {task._titles?.project && (
            <>
              {" · "}
              <Link to={`/p/${task.project}`}>{task._titles.project}</Link>
            </>
          )}
          {left > 0 && ` · ${hoursText(left)} to go`}
        </div>
      </div>
      <PriorityFlag priority={task.priority} />
      {writable ? (
        <select className="select pj-status" aria-label={`Status of ${task.subject}`} value={task.status === "Overdue" ? "Open" : (task.status ?? "Open")} onChange={(e) => onPatch(task, { status: e.target.value }, e.target.value === "Completed")}>
          {CHOOSABLE.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      ) : (
        <Badge tone="neutral">{task.status}</Badge>
      )}
      <span className="pj-row-due">
        <Due day={task.exp_end_date} late={isLate} />
      </span>
      {writable && (
        <span className="pj-snooze">
          <button type="button" className="btn btn-ghost btn-sm" title="Push the due date back a day" onClick={() => push(1)}>
            +1 day
          </button>
          <button type="button" className="btn btn-ghost btn-sm" title="Push the due date back a week" onClick={() => push(7)}>
            +1 week
          </button>
        </span>
      )}
    </li>
  );
}

/** The week in two bars: what is planned, and what was logged, against a week's hours. */
function Week({ who, today }: { who: string; today: string }) {
  const monday = weekStart(today);
  const sunday = weekEnd(monday);
  const planned = useQuery({
    queryKey: ["projects", "plate", who, "planned", monday],
    queryFn: ({ signal }) => list<Allocation>("ResourceAllocation", { titles: true, filters: JSON.stringify([["person", "=", who], ["to_date", ">=", monday]]), sort: "from_date asc", fields: "person,project,task,from_date,to_date,hours_per_day", limit: 50 }, signal).then((r) => r.rows),
    retry: false,
  });
  const logged = useQuery({
    queryKey: ["projects", "plate", who, "logged", monday],
    queryFn: ({ signal }) => api.get<{ totals?: { hours?: string } }>("/api/reports/timesheet_summary", { user: who, from_date: monday, to_date: sunday }, signal).then((r) => Number(r.totals?.hours ?? 0)),
    retry: false,
  });
  if (planned.error && logged.error) return null;
  const booked = (planned.data ?? []).reduce((n, a) => n + hoursIn(a, monday, sunday), 0);
  return (
    <section className="card" aria-labelledby="pj-week">
      <div className="card-head">
        <h2 id="pj-week">This week</h2>
      </div>
      <div className="card-body stack">
        {(planned.isLoading || logged.isLoading) && <Spinner small label="Loading the week" />}
        {!planned.error && !planned.isLoading && (
          <div className="pj-meter">
            <span>Planned</span>
            <span className="pj-meter-bar" role="img" aria-label={`${hoursText(booked)} planned of ${CAPACITY} hours`}>
              <span data-over={booked > CAPACITY || undefined} style={{ width: `${Math.min(100, (booked / CAPACITY) * 100)}%` }} />
            </span>
            <strong>{hoursText(booked)}</strong>
          </div>
        )}
        {!logged.error && !logged.isLoading && (
          <div className="pj-meter">
            <span>Logged</span>
            <span className="pj-meter-bar" role="img" aria-label={`${hoursText(logged.data ?? 0)} logged of ${CAPACITY} hours`}>
              <span data-kind="logged" style={{ width: `${Math.min(100, ((logged.data ?? 0) / CAPACITY) * 100)}%` }} />
            </span>
            <strong>{hoursText(logged.data ?? 0)}</strong>
          </div>
        )}
        {planned.data && planned.data.length > 0 && (
          <ul className="pj-lines">
            {planned.data.map((a) => (
              <li key={a.id}>
                <span className="pj-line-title">
                  {a.task ? <Link to={`/t/${a.task}`}>{a._titles?.task ?? "Task"}</Link> : (a._titles?.project ?? "Project")}
                  {a.task && a._titles?.project && <span className="faint"> · {a._titles.project}</span>}
                </span>
                <span className="faint">
                  {shortDay(a.from_date)}
                  {a.to_date !== a.from_date && ` – ${shortDay(a.to_date)}`} · {hoursText(Number(a.hours_per_day))} a day
                </span>
              </li>
            ))}
          </ul>
        )}
        {planned.data && !planned.data.length && <p className="muted">Nothing is planned for the weeks ahead.</p>}
      </div>
    </section>
  );
}

export function MyWork() {
  useShellTitle("My work");
  const qc = useQueryClient();
  const me = (useMe().data?.user.email ?? "").toLowerCase();
  const meta = useMetaIndex().data?.entities.find((e) => e.name === "Task");
  const everyone = usePeople().data?.users ?? [];
  const [sp, setQuery] = useQueryState();
  const sees = meta?.permissions.read === "all";
  const who = ((sees && sp.get("who")) || me).toLowerCase();
  const by = sp.get("by") === "project" ? "project" : "due";
  const today = todayIso();
  const key = useMemo(() => ["projects", "plate", who, "tasks"], [who]);
  const q = useQuery({
    queryKey: key,
    enabled: !!who,
    queryFn: ({ signal }) =>
      list<Task>("Task", { titles: true, filters: JSON.stringify([["assigned_to.user", "=", who], ["status", "not in", DONE]]), fields: FIELDS, sort: "exp_end_date asc", limit: 500, count: true }, signal).then((r) => ({ rows: r.rows, total: r.total ?? r.rows.length }) as Loaded),
  });
  useLiveEntity("Task", useCallback(() => void qc.invalidateQueries({ queryKey: ["projects", "plate"] }), [qc]));

  const tasks = q.data?.rows ?? [];
  const groups = useMemo(() => (by === "due" ? byHorizon(tasks, today) : byProject(tasks, (t) => t._titles?.project ?? "")), [tasks, by, today]);
  const sum = useMemo(() => plate(tasks, today), [tasks, today]);
  const writable = !!meta && can(meta.permissions, "write");
  const mine = who === me;
  const name = mine ? "Your work" : `${everyone.find((p) => p.email.toLowerCase() === who)?.full_name ?? who}'s work`;

  /** A change to a task, shown at once; a task that is done leaves the list. */
  const patch = useCallback(
    async (t: Task, change: Partial<Task>, gone = false) => {
      const before = qc.getQueryData<Loaded>(key);
      qc.setQueryData<Loaded>(key, (d) => d && { ...d, rows: gone ? d.rows.filter((x) => x.id !== t.id) : patched(d.rows, t.id, change) });
      try {
        await api.patch(docPath("Task", t.id), change, { ifMatch: t.version });
      } catch (e) {
        qc.setQueryData(key, before);
        toast(refusal(e), "error");
      }
      // The server works out Overdue, progress and the new version.
      void qc.invalidateQueries({ queryKey: ["projects", "plate"] });
    },
    [qc, key],
  );

  return (
    <div className="pj-page pj-plate">
      <header className="pj-head-row">
        <Nav />
        {sees && (
          <label className="pj-tools-pick">
            <span className="faint">Showing</span>
            <select className="select pj-select" value={who} onChange={(e) => setQuery({ who: e.target.value === me ? null : e.target.value })}>
              <option value={me}>Me</option>
              {everyone
                .filter((p) => p.email.toLowerCase() !== me)
                .map((p) => (
                  <option key={p.id} value={p.email.toLowerCase()}>
                    {p.full_name || p.email}
                  </option>
                ))}
            </select>
          </label>
        )}
      </header>
      <div className="page-head">
        <div>
          <h1 className="page-title">{name}</h1>
          <p className="page-sub">{new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</p>
        </div>
      </div>
      {q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} title="The tasks cannot be shown" />
      ) : !q.data ? (
        <Spinner label="Loading the tasks" />
      ) : !tasks.length ? (
        <EmptyState title={mine ? "Nothing on your plate" : "Nothing on their plate"} icon="check">
          <Link to="/">See the projects</Link>
        </EmptyState>
      ) : (
        <div className="pj-plate-body">
          <div className="pj-plate-main">
            <section className="pj-tiles" aria-label="Summary">
              <div className="pj-tile">
                <span className="pj-tile-label">Open</span>
                <span className="pj-tile-value">{sum.open}</span>
              </div>
              <div className="pj-tile">
                <span className="pj-tile-label">Late</span>
                <span className={`pj-tile-value${sum.late ? " pj-late" : ""}`}>{sum.late}</span>
              </div>
              <div className="pj-tile">
                <span className="pj-tile-label">Due today</span>
                <span className="pj-tile-value">{sum.today}</span>
              </div>
              <div className="pj-tile">
                <span className="pj-tile-label">Hours to go</span>
                <span className="pj-tile-value">{hoursText(sum.hours)}</span>
              </div>
            </section>
            <div className="segmented" role="group" aria-label="Group by">
              <button type="button" aria-pressed={by === "due"} onClick={() => setQuery({ by: null })}>
                By when it is due
              </button>
              <button type="button" aria-pressed={by === "project"} onClick={() => setQuery({ by: "project" })}>
                By project
              </button>
            </div>
            {q.data.total > tasks.length && <p className="faint">Showing the first {tasks.length} of {q.data.total} tasks.</p>}
            {groups.map((g) => (
              <section key={g.key} aria-label={g.label}>
                <h2 className="pj-group">
                  {g.label} {g.label === "Overdue" ? <Badge tone="red">{g.tasks.length}</Badge> : <span className="faint">{g.tasks.length}</span>}
                </h2>
                <ul className="pj-rows" data-ferrum-nocard="">
                  {g.tasks.map((t) => (
                    <Row key={t.id} task={t} today={today} writable={writable && mine} onPatch={(task, change, gone) => void patch(task, change, gone)} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <aside className="pj-plate-side">
            <Week who={who} today={today} />
          </aside>
        </div>
      )}
    </div>
  );
}
