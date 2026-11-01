// One task, whole: where it stands, its sub-tasks, what it waits for and what waits for it, the time
// logged on it, the issues raised against it, and everything that happened, with the talk about it.
// Its fields change where they stand, against the version on screen. The full form stays one click
// away for what only it edits.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useCallback, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { api, ApiError, docPath, errorMessage, formatDate, newKey, todayIso } from "@ferrum/client";
import { Alert, Badge, Button, EmptyState, ErrorState, Icon, PageLoading, Spinner, statusTone, toast, useLiveEntity, useShellTitle } from "@ferrum/kit";
import { can, CollabPanel, Composer, type EntityMeta, LinkInput, RecordFields, useEntityMeta, usePeople, useRecord } from "@ferrum/records";
import { Avatars, Due, PriorityFlag, Progress } from "./bits";
import { list, tasksKey, useNames } from "./data";
import { CHOOSABLE, late, num, type Task } from "./plan";
import { type AuditEvent, type Comment, counted, type Item, logsFor, story, type Timesheet } from "./story";
import { People } from "./TaskPanel";

const ICONS: Record<Item["kind"], string> = { created: "plus", status: "refresh", change: "edit", comment: "chat", time: "calendar" };

const when = (at: string) => (at ? new Date(at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");

/** A section's data: loading, failing and, for a section the person may not read, nothing at all. */
function useSection<T>(id: string, name: string, fn: (signal: AbortSignal) => Promise<T>, extra = "") {
  const q = useQuery({ queryKey: ["projects", "task", id, name, extra], queryFn: ({ signal }) => fn(signal) });
  const hidden = q.error instanceof ApiError && q.error.status === 403;
  return { q, hidden };
}

function Card({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="card pj-section" aria-label={title}>
      <div className="card-head">
        <h2>{title}</h2>
        <span className="spacer" />
        {aside}
      </div>
      <div className="card-body">{children}</div>
    </section>
  );
}

/** The state of a section's request, in words: nothing to draw until it has something. */
function Waiting({ q, what }: { q: { isLoading: boolean; error: unknown; refetch: () => unknown }; what: string }) {
  if (q.error) {
    return (
      <p className="muted">
        {what} cannot be shown. <button type="button" className="link-btn" onClick={() => void q.refetch()}>Try again</button>
      </p>
    );
  }
  return q.isLoading ? <Spinner small label={`Loading ${what.toLowerCase()}`} /> : null;
}

// ── sub-tasks ──

function SubTasks({ task, canWrite, changed }: { task: Task; canWrite: boolean; changed: () => void }) {
  const names = useNames();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const { q, hidden } = useSection(task.id, "kids", (signal) =>
    list<Task>("Task", { filters: JSON.stringify([["parent_task", "=", task.id]]), fields: "number,subject,status,priority,exp_end_date,assigned_to,version", sort: "created_at asc", limit: 200 }, signal).then((r) => r.rows),
  );
  if (hidden) return null;
  const kids = (q.data ?? []).filter((k) => k.status !== "Cancelled");
  const done = kids.filter((k) => k.status === "Completed").length;
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const subject = text.trim();
    if (!subject || !task.project) return;
    setBusy(true);
    try {
      await api.post("/api/v1/Task", { subject, project: task.project, parent_task: task.id, status: "Open" }, { idempotencyKey: newKey() });
      setText("");
      changed();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };
  const tick = async (k: Task) => {
    try {
      await api.patch(docPath("Task", k.id), { status: k.status === "Completed" ? "Open" : "Completed" }, { ifMatch: k.version });
      changed();
    } catch (err) {
      toast(errorMessage(err), "error");
      changed();
    }
  };
  const now = todayIso();
  return (
    <Card title={kids.length ? `Sub-tasks, ${done} of ${kids.length} done` : "Sub-tasks"} aside={kids.length > 0 ? <Progress value={(done / kids.length) * 100} label="Sub-tasks done" /> : undefined}>
      <Waiting q={q} what="The sub-tasks" />
      {q.data && !kids.length && <p className="muted">It is not split into smaller tasks.</p>}
      <ul className="pj-lines">
        {kids.map((k) => (
          <li key={k.id}>
            <button type="button" className="pj-tick" data-done={k.status === "Completed" || undefined} disabled={!canWrite} aria-label={`${k.status === "Completed" ? "Reopen" : "Complete"} ${k.subject}`} onClick={() => void tick(k)}>
              <Icon name="check" size={12} />
            </button>
            <Link to={`/t/${k.id}`} className="pj-line-title">
              {k.subject}
            </Link>
            <PriorityFlag priority={k.priority} />
            <Due day={k.exp_end_date} late={late(k, now)} />
            <Avatars emails={(k.assigned_to ?? []).map((a) => a.user ?? "").filter(Boolean)} names={names} max={2} />
          </li>
        ))}
      </ul>
      {canWrite && (
        <form className="pj-add" onSubmit={(e) => void add(e)}>
          <input className="input" aria-label="Add a sub-task" placeholder="Add a sub-task" value={text} readOnly={busy} onChange={(e) => setText(e.target.value)} />
          <Button type="submit" size="sm" loading={busy} disabled={!text.trim()}>
            Add
          </Button>
        </form>
      )}
    </Card>
  );
}

// ── what it waits for ──

function Waits({ task, project, rows, canWrite, save }: { task: Task; project: string; rows: { id?: string; task?: string | null }[]; canWrite: boolean; save: (name: string, value: unknown) => Promise<void> }) {
  const ids = rows.map((r) => r.task ?? "").filter(Boolean);
  const first = useSection(task.id, "waits", (signal) => (ids.length ? list<Task>("Task", { filters: JSON.stringify([["id", "in", ids]]), fields: "number,subject,status,exp_end_date", limit: 100 }, signal).then((r) => r.rows) : Promise.resolve([] as Task[])), ids.join(","));
  const then = useSection(task.id, "blocks", (signal) => list<Task>("Task", { filters: JSON.stringify([["depends_on.task", "=", task.id]]), fields: "number,subject,status,exp_end_date", limit: 100 }, signal).then((r) => r.rows));
  if (first.hidden && then.hidden) return null;
  const before = first.q.data ?? [];
  const holding = before.filter((b) => b.status !== "Completed");
  const keep = (r: (typeof rows)[number]) => ({ id: r.id, task: r.task });
  return (
    <Card title="Order of work">
      <Waiting q={first.q} what="What it waits for" />
      {holding.length > 0 && task.status !== "Completed" && (
        <Alert tone="warning">
          It cannot start until {holding.map((h) => h.number ?? h.subject).join(", ")} {holding.length === 1 ? "is" : "are"} completed.
        </Alert>
      )}
      <h3 className="pj-minor">Waits for</h3>
      <ul className="pj-lines">
        {before.map((b) => (
          <li key={b.id}>
            <Badge tone={statusTone(b.status)}>{b.status}</Badge>
            <Link to={`/t/${b.id}`} className="pj-line-title">
              {b.number} {b.subject}
            </Link>
            <Due day={b.exp_end_date} late={late(b, todayIso())} />
            {canWrite && (
              <button type="button" className="icon-btn icon-btn-sm" aria-label={`It no longer waits for ${b.subject}`} onClick={() => void save("depends_on", rows.filter((r) => r.task !== b.id).map(keep))}>
                <Icon name="x" size={13} />
              </button>
            )}
          </li>
        ))}
        {first.q.data && !before.length && <li className="faint">Nothing. It can start whenever.</li>}
      </ul>
      {canWrite && (
        <div className="pj-pick">
          <LinkInput to="Task" value={null} label="Waits for another task" placeholder="Wait for another task…" linkFilters={{ project }} onChange={(picked) => picked && picked !== task.id && void save("depends_on", [...rows.map(keep), { task: picked }])} />
        </div>
      )}
      <h3 className="pj-minor">Others wait for it</h3>
      <Waiting q={then.q} what="The tasks after it" />
      <ul className="pj-lines">
        {(then.q.data ?? []).map((b) => (
          <li key={b.id}>
            <Badge tone={statusTone(b.status)}>{b.status}</Badge>
            <Link to={`/t/${b.id}`} className="pj-line-title">
              {b.number} {b.subject}
            </Link>
            <Due day={b.exp_end_date} late={late(b, todayIso())} />
          </li>
        ))}
        {then.q.data && !then.q.data.length && <li className="faint">Nothing waits for it.</li>}
      </ul>
    </Card>
  );
}

// ── time ──

function TimeLogged({ task, doc }: { task: Task; doc: Record<string, unknown> }) {
  const { q, hidden } = useSection(task.id, "time", (signal) => list<Timesheet>("Timesheet", { filters: JSON.stringify([["time_logs.task", "=", task.id]]), fields: "user,docstatus,time_logs", limit: 100 }, signal).then((r) => r.rows));
  const names = useNames();
  if (hidden) return null;
  const logs = logsFor(q.data ?? [], task.id);
  const logged = counted(logs);
  const estimate = num(doc.expected_hours as string | number | null);
  const shared = typeof doc.project === "string" ? doc.project : "";
  return (
    <Card
      title="Time"
      aside={
        <Link className="btn btn-sm" to={`/e/Timesheet/new?project=${shared}`}>
          Log time
        </Link>
      }
    >
      <Waiting q={q} what="The time logged" />
      {q.data && (
        <p className="pj-hours">
          <strong className={estimate > 0 && logged > estimate ? "pj-late" : undefined}>{logged} h</strong>
          <span className="faint"> logged{estimate > 0 ? ` of ${estimate} h expected` : ""}</span>
        </p>
      )}
      {q.data && !logs.length && <p className="muted">No time logged on it yet.</p>}
      <ul className="pj-lines">
        {logs.slice(0, 8).map((l) => (
          <li key={l.key}>
            <span className="pj-line-title">
              {l.hours} h · {names(l.user)}
              {l.what && <span className="faint"> · {l.what}</span>}
            </span>
            {!l.counted && <Badge tone="amber">Not submitted</Badge>}
            <span className="faint">{l.at ? formatDate(l.at.slice(0, 10)) : ""}</span>
          </li>
        ))}
      </ul>
      {logs.length > 8 && <p className="faint">and {logs.length - 8} more in the timesheets.</p>}
    </Card>
  );
}

// ── issues ──

function Issues({ task }: { task: Task }) {
  const { q, hidden } = useSection(task.id, "issues", (signal) => list<{ id: string; title?: string; severity?: string; status?: string }>("ProjectIssue", { filters: JSON.stringify([["task", "=", task.id]]), fields: "title,severity,status", limit: 50 }, signal).then((r) => r.rows));
  if (hidden || (q.data && !q.data.length)) return null;
  return (
    <Card title="Issues raised against it">
      <Waiting q={q} what="The issues" />
      <ul className="pj-lines">
        {(q.data ?? []).map((i) => (
          <li key={i.id}>
            <Badge tone={i.severity === "Critical" || i.severity === "High" ? "red" : "neutral"}>{i.severity}</Badge>
            <Link to={`/e/ProjectIssue/${i.id}`} className="pj-line-title">
              {i.title}
            </Link>
            <Badge tone={statusTone(i.status)}>{i.status}</Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ── what happened ──

function Story({ id, changed }: { id: string; changed: () => void }) {
  const people = usePeople().data?.users ?? [];
  const names = useNames();
  const audit = useSection(id, "audit", (signal) => api.get<{ events: AuditEvent[] }>(docPath("Task", id, "audit"), undefined, signal).then((r) => r.events));
  const talk = useSection(id, "comments", (signal) => api.get<{ comments: Comment[] }>(docPath("Task", id, "comments"), undefined, signal).then((r) => r.comments));
  const sheets = useSection(id, "time", (signal) => list<Timesheet>("Timesheet", { filters: JSON.stringify([["time_logs.task", "=", id]]), fields: "user,docstatus,time_logs", limit: 100 }, signal).then((r) => r.rows));
  const words = useCallback((field: string, v: unknown) => (v == null || v === "" ? "" : field.endsWith("_date") ? formatDate(v) : field === "progress" ? `${Number(v)}%` : field === "expected_hours" ? `${Number(v)} h` : field === "is_milestone" ? (v ? "Yes" : "No") : String(v)), []);
  const items = useMemo(() => story(audit.q.data ?? [], talk.q.data ?? [], logsFor(sheets.q.data ?? [], id), words), [audit.q.data, talk.q.data, sheets.q.data, id, words]);
  const writable = !talk.hidden;
  const post = async (body: string, mentions: string[]) => {
    try {
      await api.post(docPath("Task", id, "comments"), { body, mentions });
      changed();
      return true;
    } catch (e) {
      toast(errorMessage(e), "error");
      return false;
    }
  };
  const loading = audit.q.isLoading || talk.q.isLoading;
  const failed = audit.q.error && !audit.hidden ? audit.q : talk.q.error && !talk.hidden ? talk.q : null;
  return (
    <div className="stack">
      {writable && <Composer people={people} onPost={post} />}
      {failed ? (
        <ErrorState error={failed.error} onRetry={() => void failed.refetch()} title="The story cannot be shown" />
      ) : loading ? (
        <PageLoading label="Loading the story" />
      ) : items.length ? (
        <ol className="pj-events">
          {items.map((i) => (
            <li key={i.key} className="pj-event" data-kind={i.kind}>
              <span className="pj-event-icon" aria-hidden="true">
                <Icon name={ICONS[i.kind]} size={13} />
              </span>
              <div className="pj-event-body">
                <div className="pj-event-line">
                  <strong>{i.title}</strong>
                  <time className="faint">{when(i.at)}</time>
                </div>
                {i.detail && <p className="pj-event-detail">{i.detail}</p>}
                {i.who && <div className="faint pj-event-who">{names(i.who)}</div>}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">Nothing has happened yet.</p>
      )}
    </div>
  );
}

// ── the page ──

function TaskPage({ meta, id }: { meta: EntityMeta; id: string }) {
  const qc = useQueryClient();
  const { record, save: saveField } = useRecord(meta, id);
  const [view, setView] = useState<"story" | "discussion">("story");
  const names = useNames();
  const doc = record.data;
  const project = typeof doc?.project === "string" ? doc.project : "";
  const writable = can(meta.permissions, "write");
  useShellTitle(doc ? String(doc.subject ?? "Task") : null);

  const changed = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["projects", "task", id] });
    void qc.invalidateQueries({ queryKey: ["peek", "Task", id] });
    if (project) void qc.invalidateQueries({ queryKey: tasksKey(project) });
  }, [qc, id, project]);
  const save = (name: string, value: unknown) => saveField(name, value).then(changed);
  useLiveEntity("Task", changed);
  useLiveEntity("Timesheet", changed);
  useLiveEntity("ProjectIssue", changed);

  if (record.error) {
    if (record.error instanceof ApiError && record.error.status === 404) {
      return (
        <EmptyState title="This task no longer exists">
          <Link to="/my">Back to your work</Link>
        </EmptyState>
      );
    }
    return <ErrorState error={record.error} onRetry={() => void record.refetch()} />;
  }
  if (!doc) return <PageLoading label="Loading the task" />;

  const status = String(doc.status ?? "Open");
  const done = status === "Completed" || status === "Cancelled";
  const task: Task = { id, version: doc.version, number: String(doc.number ?? ""), subject: String(doc.subject ?? ""), status, project, expected_hours: doc.expected_hours as string, actual_hours: doc.actual_hours as string };
  const people = (doc.assigned_to as { user?: string }[] | undefined) ?? [];
  const waits = (doc.depends_on as { id?: string; task?: string | null }[] | undefined) ?? [];
  const where = doc._titles?.project;
  const overdue = late({ id, status, exp_end_date: doc.exp_end_date as string }, todayIso());

  return (
    <div className="pj-page pj-task-page">
      <div className="crumbs">
        <Link to="/">Projects</Link>
        <Icon name="chevronRight" size={12} />
        {project ? <Link to={`/p/${project}`}>{where ?? "Project"}</Link> : <span>Project</span>}
      </div>
      <header className="pj-task-head">
        <div className="pj-task-title">
          <p className="faint pj-mono">
            {task.number}
            {doc.is_milestone ? " · Milestone" : ""}
            {doc.parent_task && doc._titles?.parent_task ? (
              <>
                {" · in "}
                <Link to={`/t/${String(doc.parent_task)}`}>{doc._titles.parent_task}</Link>
              </>
            ) : null}
          </p>
          <h1 className="page-title">{task.subject}</h1>
          <p className="row pj-facts">
            <Badge tone={statusTone(status)}>{status}</Badge>
            <PriorityFlag priority={doc.priority as string} always />
            {typeof doc.exp_end_date === "string" && (
              <span className={overdue ? "pj-late" : "faint"}>
                {doc.exp_start_date ? `${formatDate(doc.exp_start_date)} – ` : "Due "}
                {formatDate(doc.exp_end_date)}
              </span>
            )}
            <Avatars emails={people.map((p) => p.user ?? "").filter(Boolean)} names={names} max={4} />
          </p>
        </div>
        <div className="page-actions">
          {writable && !done && (
            <Button variant="primary" icon="check" onClick={() => void save("status", "Completed")}>
              Mark complete
            </Button>
          )}
          {writable && status === "Completed" && <Button onClick={() => void save("status", "Open")}>Reopen</Button>}
          <Link className="icon-btn" to={`/e/Task/${id}`} title="Open the full form" aria-label="Open the full form">
            <Icon name="expand" size={15} />
          </Link>
        </div>
      </header>
      <ol className="pj-strip" aria-label="Status">
        {CHOOSABLE.map((s, i) => {
          const at = CHOOSABLE.indexOf(status === "Overdue" ? "Open" : status);
          return (
            <li key={s} data-state={i < at ? "past" : i === at ? "current" : undefined}>
              <button type="button" disabled={!writable || status === "Cancelled" || s === status} aria-current={i === at ? "step" : undefined} onClick={() => void save("status", s)}>
                {s}
              </button>
            </li>
          );
        })}
      </ol>
      {status === "Cancelled" && <Alert tone="info">This task was cancelled.</Alert>}
      <div className="pj-task-body">
        <div className="pj-task-main">
          <div className="pj-switch" role="tablist" aria-label="View">
            {(["story", "discussion"] as const).map((v) => (
              <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}>
                {v === "story" ? "Story" : "Discussion"}
              </button>
            ))}
          </div>
          {view === "discussion" ? (
            <CollabPanel entity="Task" id={id} canWrite={writable} />
          ) : (
            <>
              <SubTasks task={task} canWrite={writable} changed={changed} />
              <Waits task={task} project={project} rows={waits} canWrite={writable} save={save} />
              <TimeLogged task={task} doc={doc} />
              <Issues task={task} />
              <Card title="What happened">
                <Story id={id} changed={changed} />
              </Card>
            </>
          )}
        </div>
        <aside className="pj-task-side" aria-label="Task details">
          <People doc={doc} canWrite={writable} save={save} />
          <RecordFields meta={meta} doc={doc} save={save} />
        </aside>
      </div>
    </div>
  );
}

export function TaskRoute() {
  const { id = "" } = useParams();
  const meta = useEntityMeta("Task");
  if (meta.error) return <ErrorState error={meta.error} onRetry={() => void meta.refetch()} />;
  if (!meta.data) return <PageLoading />;
  return <TaskPage key={id} meta={meta.data} id={id} />;
}
