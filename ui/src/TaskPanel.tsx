// A task beside the board or the timeline: its fields change where they stand (each against the
// version on screen), people go on and off it, its sub-tasks and what it waits for are one click
// away, and the discussion is a tab. The page of the task holds the whole story.

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { Badge, ErrorState, Icon, PageLoading, statusTone, useLiveEntity } from "@ferrum/kit";
import { can, CollabPanel, type Doc, type EntityMeta, RecordFields, useEntityMeta, usePeople, useRecord } from "@ferrum/records";
import { Avatar } from "./bits";
import { tasksKey, useNames } from "./data";
import { CHOOSABLE, type Task, waitsFor } from "./plan";

type Rows = { id?: string; user?: string | null }[];

/** Who is on the task: each can be taken off it, and anyone in the workspace put on. */
export function People({ doc, canWrite, save }: { doc: Doc; canWrite: boolean; save: (name: string, value: unknown) => Promise<void> }) {
  const names = useNames();
  const everyone = usePeople().data?.users ?? [];
  const rows = (doc.assigned_to as Rows | undefined) ?? [];
  const keep = (r: Rows[number]) => ({ id: r.id, user: r.user });
  const on = new Set(rows.map((r) => (r.user ?? "").toLowerCase()));
  return (
    <section className="peek-section" aria-label="People">
      <h3>People</h3>
      <ul className="pj-people">
        {rows.map((r) => (
          <li key={r.id ?? r.user}>
            <Avatar email={r.user ?? ""} name={names(r.user)} />
            <span>{names(r.user)}</span>
            {canWrite && (
              <button type="button" className="icon-btn icon-btn-sm" aria-label={`Take ${names(r.user)} off this task`} onClick={() => void save("assigned_to", rows.filter((x) => x !== r).map(keep))}>
                <Icon name="x" size={13} />
              </button>
            )}
          </li>
        ))}
        {!rows.length && <li className="faint">Nobody yet</li>}
      </ul>
      {canWrite && (
        <select
          className="select pj-select"
          aria-label="Put someone on this task"
          value=""
          onChange={(e) => e.target.value && void save("assigned_to", [...rows.map(keep), { user: e.target.value }])}
        >
          <option value="">Add someone…</option>
          {everyone
            .filter((u) => !on.has(u.email.toLowerCase()))
            .map((u) => (
              <option key={u.id} value={u.email}>
                {u.full_name || u.email}
              </option>
            ))}
        </select>
      )}
    </section>
  );
}

/** Tasks related to this one, as short lines that open in the panel. */
function Related({ title, tasks, onOpen }: { title: string; tasks: Task[]; onOpen: (id: string) => void }) {
  if (!tasks.length) return null;
  return (
    <section className="peek-section" aria-label={title}>
      <h3>{title}</h3>
      <ul className="pj-mini">
        {tasks.map((t) => (
          <li key={t.id}>
            <Badge tone={statusTone(t.status)}>{t.status}</Badge>
            <button type="button" className="link-btn" onClick={() => onOpen(t.id)}>
              {t.number} {t.subject}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Panel({ meta, id, project, tasks, onOpen, onClose }: { meta: EntityMeta; id: string; project: string; tasks: Task[]; onOpen: (id: string | null) => void; onClose: () => void }) {
  const qc = useQueryClient();
  const { record, save: saveField } = useRecord(meta, id);
  const [tab, setTab] = useState<"details" | "discussion">("details");
  const root = useRef<HTMLElement>(null);
  const doc = record.data;
  const writable = can(meta.permissions, "write");

  // The board and the timeline show the same tasks: a change here reaches them at once.
  const save = (name: string, value: unknown) => saveField(name, value).then(() => void qc.invalidateQueries({ queryKey: tasksKey(project) }));
  useLiveEntity(
    "Task",
    useCallback((e) => void (e.id === id && qc.invalidateQueries({ queryKey: ["peek", "Task", id] })), [qc, id]),
  );

  // Focus comes to the panel when it opens, and goes back to the card when it closes.
  useEffect(() => {
    root.current?.focus({ preventScroll: true });
    return () => {
      if (!document.activeElement || document.activeElement === document.body || root.current?.contains(document.activeElement)) {
        document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`)?.focus();
      }
    };
  }, [id]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !e.defaultPrevented && !(e.target as HTMLElement).closest("[role=listbox], [role=dialog]")) onClose();
  };

  const kids = tasks.filter((t) => t.parent_task === id && t.status !== "Cancelled");
  const me = tasks.find((t) => t.id === id);
  const waits = me ? waitsFor(me).map((w) => tasks.find((t) => t.id === w)).filter((t): t is Task => !!t) : [];
  const blocks = tasks.filter((t) => waitsFor(t).includes(id));
  const status = typeof doc?.status === "string" ? doc.status : "Open";

  return (
    <aside className="peek pj-panel" aria-label={doc ? `${doc.number} ${doc.subject}` : "Task"} ref={root} tabIndex={-1} onKeyDown={onKeyDown}>
      <header className="peek-head">
        <div className="peek-title">
          <h2>{doc ? String(doc.subject ?? doc.number) : "…"}</h2>
          {doc && <span className="faint pj-mono">{String(doc.number ?? "")}</span>}
        </div>
        <Link className="icon-btn" to={`/t/${id}`} aria-label="Open the task page" title="Open the task page">
          <Icon name="expand" size={15} />
        </Link>
        <button type="button" className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <Icon name="x" size={15} />
        </button>
      </header>
      {writable && doc && (
        <div className="pj-steps" role="group" aria-label="Status">
          {CHOOSABLE.map((s) => (
            <button key={s} type="button" aria-pressed={s === status || (status === "Overdue" && s === "Open")} onClick={() => s !== status && void save("status", s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      <div className="peek-tabs" role="tablist">
        {(["details", "discussion"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t === "details" ? "Details" : "Discussion"}
          </button>
        ))}
      </div>
      <div className="peek-body">
        {record.error ? (
          <ErrorState error={record.error} onRetry={() => void record.refetch()} title="The task cannot be shown" />
        ) : !doc ? (
          <PageLoading label="Loading the task" />
        ) : tab === "discussion" ? (
          <CollabPanel entity="Task" id={id} canWrite={writable} />
        ) : (
          <>
            <People doc={doc} canWrite={writable} save={save} />
            <RecordFields meta={meta} doc={doc} save={save} />
            <Related title={kids.length ? `Sub-tasks, ${kids.filter((k) => k.status === "Completed").length} of ${kids.length} done` : "Sub-tasks"} tasks={kids} onOpen={onOpen} />
            <Related title="Waits for" tasks={waits} onOpen={onOpen} />
            <Related title="Others wait for this" tasks={blocks} onOpen={onOpen} />
            <p className="pj-panel-foot">
              <Link to={`/t/${id}`}>Open the whole story</Link>
            </p>
          </>
        )}
      </div>
    </aside>
  );
}

export function TaskPanel(props: { id: string; project: string; tasks: Task[]; onOpen: (id: string | null) => void; onClose: () => void }) {
  const meta = useEntityMeta("Task");
  if (meta.error) return <ErrorState error={meta.error} onRetry={() => void meta.refetch()} />;
  if (!meta.data) return <PageLoading label="Loading the task" />;
  return <Panel key={props.id} meta={meta.data} {...props} />;
}
