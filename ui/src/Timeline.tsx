// The timeline: each task a bar over its days, tasks that wait for others joined by arrows. A bar
// is dragged to move it and by its ends to resize it (days at a time), a dot at its end is dragged
// to another bar to make that one wait for it, and an empty row takes dates from a click. Moving a
// task that others wait for first shows what would move (old places ghosted, new ones solid) and
// asks; nothing is written until the person agrees, and the last change can be undone. Every move
// has a keyboard way (arrow keys; Shift for a week; Alt for the end) and the task's fields in the
// side panel.

import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Diamond, Undo2 } from "lucide-react";
import { type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { todayIso, t as tr } from "@ferrum/client";
import { Alert, Button, EmptyState, toast } from "@ferrum/kit";
import { can, useMetaIndex } from "@ferrum/records";
import { Keys } from "./bits";
import { changeTask, type Project, type TaskSet, useQueryState } from "./data";
import { diffDays, shortDay } from "./days";
import { patched, type Task, waitsFor } from "./plan";
import { arrow, cascade, critical, dayAt, dayUnder, dragged, firstDates, header, length, links, type Mode, outline, PX, type Plan, readZoom, type Row, spanOf, type Span, viewOf, type View, weekends, writes, ZOOMS, type Zoom } from "./schedule";

/** The height of a row, in pixels. */
const ROW = 36;
const ZOOM_NAMES: Record<Zoom, string> = { day: "Day", week: "Week", month: "Month", quarter: "Quarter" };

/** A press on a bar, until it is let go. */
interface Held {
  id: string;
  mode: Mode | "link";
  x0: number;
  /** How far the pointer goes before a press is a drag and no longer a click: a finger needs more room. */
  slop: number;
  moved: boolean;
}

/** What an edit asks: the task, which part of its bar, and by how many days. */
interface Ask {
  id: string;
  mode: Mode;
  days: number;
}

/** Dates as they were before a change, to put them back. */
type Undo = { id: string; start: string | null; end: string | null }[];

const still = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** "3 days later", "a week earlier". */
function describeShift(a: Ask): string {
  const n = Math.abs(a.days);
  const by = n === 7 ? "a week" : `${n} ${n === 1 ? "day" : "days"}`;
  const how = a.mode === "end" ? (a.days > 0 ? "longer" : "shorter") : a.mode === "start" ? (a.days > 0 ? "to start later" : "to start earlier") : a.days > 0 ? "later" : "earlier";
  return `${by} ${how}`;
}

export function Timeline({ project, set: tasks, open, onOpen }: { project: Project; set: TaskSet; open: string | null; onOpen: (id: string | null) => void }) {
  const qc = useQueryClient();
  const meta = useMetaIndex().data?.entities.find((e) => e.name === "Task");
  const [sp, setQuery] = useQueryState();
  const zoom = readZoom(sp.get("zoom"));
  const path = sp.get("path") === "1";
  const today = todayIso();
  const closed = project.status === "Completed" || project.status === "Cancelled";
  const canWrite = !!meta && can(meta.permissions, "write") && !closed;

  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<Ask | null>(null);
  const [pending, setPending] = useState<Ask | null>(null);
  const [linking, setLinking] = useState<{ from: string; x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ from: string; to: string; x: number; y: number } | null>(null);
  const [past, setPast] = useState<Undo[]>([]);
  const [note, setNote] = useState("");
  const held = useRef<Held | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);

  const byId = useMemo(() => new Map(tasks.rows.map((t) => [t.id, t])), [tasks.rows]);
  const out = useMemo(() => outline(tasks.rows, folded), [tasks.rows, folded]);

  // The days shown only ever widen while this screen is open, so a bar dragged past the edge does
  // not make everything jump; when they widen to the left the scroll is kept where it was.
  const range = useRef<{ key: string; from: string; to: string } | null>(null);
  const keep = useRef(0);
  const spans = [...out.rows.flatMap((r) => (r.span ? [r.span] : [])), ...(project.start_date && project.end_date ? [{ start: project.start_date, end: project.end_date }] : [])];
  const fresh = viewOf(spans, today, zoom);
  const key = `${project.id}|${zoom}`;
  if (!range.current || range.current.key !== key) range.current = { key, from: fresh.from, to: fresh.to };
  else {
    if (fresh.from < range.current.from) {
      keep.current += diffDays(fresh.from, range.current.from) * fresh.px;
      range.current.from = fresh.from;
    }
    if (fresh.to > range.current.to) range.current.to = fresh.to;
  }
  const view: View = { zoom, from: range.current.from, to: range.current.to, days: diffDays(range.current.from, range.current.to) + 1, px: PX[zoom] };
  const width = view.days * view.px;

  useLayoutEffect(() => {
    if (keep.current && scroller.current) {
      scroller.current.scrollLeft += keep.current;
      keep.current = 0;
    }
  });

  const toToday = (smooth: boolean) => {
    const el = scroller.current;
    if (el) el.scrollTo({ left: Math.max(0, dayAt(view, today) * view.px - el.clientWidth / 3), behavior: smooth && !still() ? "smooth" : "auto" });
  };
  useEffect(() => toToday(false), [key]);

  // What the person's current edit moves, shown as it would be until it is let go or agreed to.
  const asked = drag ?? pending;
  const plan: Plan | null = useMemo(() => {
    if (!asked) return null;
    const task = byId.get(asked.id);
    const edit = task && dragged(task, asked.mode, asked.days);
    return edit ? cascade(tasks.rows, [edit]) : null;
  }, [asked?.id, asked?.mode, asked?.days, tasks.rows, byId]);
  const shifted = useMemo(() => new Map((plan?.changes ?? []).map((c) => [c.id, c])), [plan]);
  const shown = useMemo(() => out.rows.map((r): Row => ({ ...r, span: shifted.get(r.task.id)?.after ?? r.span })), [out.rows, shifted]);
  const lines = useMemo(() => links(shown), [shown]);
  const tight = useMemo(() => (path ? critical(tasks.rows) : new Set<string>()), [path, tasks.rows]);
  const head = useMemo(() => header(view), [view.from, view.to, view.zoom]);
  const weekend = useMemo(() => weekends(view), [view.from, view.to, view.zoom]);

  const rowOf = new Map(shown.map((r, i) => [r.task.id, i]));
  const rowsHigh = shown.length + (out.unscheduled.length ? out.unscheduled.length + 1 : 0);
  const leftOf = (r: Row): number => (r.span ? (r.task.is_milestone ? (dayAt(view, r.span.end) + 0.5) * view.px - 8 : dayAt(view, r.span.start) * view.px) : 0);
  const rightOf = (r: Row): number => (r.span ? (r.task.is_milestone ? (dayAt(view, r.span.end) + 0.5) * view.px + 8 : (dayAt(view, r.span.end) + 1) * view.px) : 0);
  const middle = (id: string) => {
    const i = rowOf.get(id);
    return i === undefined ? null : { row: shown[i], y: i * ROW + ROW / 2 };
  };
  const zoomTo = (z: Zoom) => setQuery({ zoom: z === "week" ? null : z });

  // ── changing dates ──

  const commit = (p: Plan) => {
    const prior: Undo = p.changes.map((c) => ({ id: c.id, start: byId.get(c.id)?.exp_start_date ?? null, end: byId.get(c.id)?.exp_end_date ?? null }));
    const send = (c: Plan["changes"][number], quiet: boolean, after?: Promise<boolean>) => {
      const task = byId.get(c.id);
      return task ? changeTask(qc, project.id, task, writes(task, c), quiet, after) : Promise.resolve(false);
    };
    // What the person moved goes first; what follows from it is sent only if that was accepted.
    const first = Promise.all(p.changes.filter((c) => c.kind === "dragged").map((c) => send(c, false))).then((r) => r.every(Boolean));
    for (const c of p.changes.filter((x) => x.kind !== "dragged")) void send(c, true, first);
    setPast((h) => [...h.slice(-19), prior]);
    setPending(null);
    setNote(p.changes.length === 1 ? "Dates changed." : `Dates changed for ${p.changes.length} tasks.`);
  };

  const undo = () => {
    const last = past[past.length - 1];
    if (!last) return;
    setPast((h) => h.slice(0, -1));
    for (const u of last) {
      const task = byId.get(u.id);
      if (task) void changeTask(qc, project.id, task, { exp_start_date: u.start, exp_end_date: u.end });
    }
    setNote("Undone.");
  };

  /** Asks the question when others would move too (Alt skips it); otherwise just does it. */
  const propose = (task: Task, mode: Mode, days: number, skip: boolean) => {
    const edit = dragged(task, mode, days);
    if (!edit) return;
    const p = cascade(tasks.rows, [edit]);
    if (!p.changes.length) return;
    if (!skip && p.changes.some((c) => c.kind !== "dragged")) setPending({ id: task.id, mode, days });
    else commit(p);
  };

  const give = (task: Task, day: string) => {
    const s = firstDates(day, zoom);
    void changeTask(qc, project.id, task, { exp_start_date: s.start, exp_end_date: s.end });
  };

  const addLink = async (from: string, to: string) => {
    const succ = byId.get(to);
    if (!succ || from === to) return;
    if (waitsFor(succ).includes(from)) {
      toast(tr("That task already waits for the other."), "info");
      return;
    }
    const rows = [...(succ.depends_on ?? []).map((d) => ({ id: d.id, task: d.task })), { task: from }];
    if (!(await changeTask(qc, project.id, succ, { depends_on: rows }))) return;
    // The dates may not fit the new link: show what keeping it would move.
    const pred = byId.get(from);
    const s = pred && spanOf(pred);
    const fix = s && cascade(patched(tasks.rows, to, { depends_on: rows }), [{ id: from, start: s.start, end: s.end }]);
    if (fix?.changes.length) setPending({ id: from, mode: "move", days: 0 });
  };

  const removeLink = (from: string, to: string) => {
    const succ = byId.get(to);
    if (succ) void changeTask(qc, project.id, succ, { depends_on: (succ.depends_on ?? []).filter((d) => d.task !== from).map((d) => ({ id: d.id, task: d.task })) });
    setMenu(null);
  };

  // ── the pointer ──

  const onDown = (e: PointerEvent<HTMLDivElement>, r: Row) => {
    if (!canWrite || e.button !== 0 || !r.span) return;
    const grip = (e.target as HTMLElement).dataset.grip;
    const mode = grip === "start" || grip === "end" || grip === "link" ? grip : "move";
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture(e.pointerId);
    held.current = { id: r.task.id, mode: r.task.is_milestone && mode !== "link" ? "move" : mode, x0: e.clientX, slop: e.pointerType === "mouse" ? 4 : 10, moved: false };
    setMenu(null);
  };

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const h = held.current;
    if (!h) return;
    const dx = e.clientX - h.x0;
    if (Math.abs(dx) > h.slop) h.moved = true;
    if (h.mode === "link") {
      const box = canvas.current?.getBoundingClientRect();
      if (box && h.moved) setLinking({ from: h.id, x: e.clientX - box.left, y: e.clientY - box.top });
      return;
    }
    if (!h.moved) return;
    const mode = h.mode;
    const days = Math.round(dx / view.px);
    setDrag((d) => (d && d.days === days ? d : { id: h.id, mode, days }));
  };

  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const h = held.current;
    held.current = null;
    setDrag(null);
    setLinking(null);
    if (!h) return;
    if (h.mode === "link") {
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-bar]")?.dataset.bar;
      if (target && h.moved) void addLink(h.id, target);
      return;
    }
    if (!h.moved) {
      onOpen(h.id);
      return;
    }
    const task = byId.get(h.id);
    const days = Math.round((e.clientX - h.x0) / view.px);
    if (task && days) propose(task, h.mode, days, e.altKey);
  };

  /** A press that the system took over (a touch that became a scroll) is let go of, not finished. */
  const onCancel = () => {
    held.current = null;
    setDrag(null);
    setLinking(null);
  };

  // Escape lets go of a drag, drops the question, closes a link's menu.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || !(held.current || pending || menu)) return;
      held.current = null;
      setDrag(null);
      setLinking(null);
      setPending(null);
      setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, menu]);

  const onBarKey = (e: KeyboardEvent<HTMLElement>, r: Row) => {
    const t = r.task;
    if (e.key === "Enter") {
      onOpen(t.id);
      return;
    }
    if (!canWrite || !r.span || r.summary) return;
    const way = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!way) return;
    e.preventDefault();
    const days = way * (e.shiftKey ? 7 : 1);
    const mode: Mode = e.altKey && !t.is_milestone ? "end" : "move";
    // While a question is open, more presses change what it asks about.
    if (pending && pending.id === t.id && pending.mode === mode) setPending({ ...pending, days: pending.days + days });
    else propose(t, mode, days, false);
  };

  const onKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    const tag = (e.target as HTMLElement).tagName;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(tag)) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undo();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || tag === "BUTTON") return;
    const k = e.key.toLowerCase();
    const named = ({ d: "day", w: "week", m: "month", q: "quarter" } as Record<string, Zoom>)[k];
    const at = ZOOMS.indexOf(zoom);
    if (named) zoomTo(named);
    else if (e.key === "+" || e.key === "=") zoomTo(ZOOMS[Math.max(0, at - 1)]);
    else if (e.key === "-") zoomTo(ZOOMS[Math.min(ZOOMS.length - 1, at + 1)]);
    else if (k === "t") toToday(true);
    else if (k === "c") setQuery({ path: path ? null : "1" });
  };

  /** A click on the empty row of a task with no dates gives it some, from the day clicked. */
  const onEmpty = (e: MouseEvent<HTMLDivElement>) => {
    if (!canWrite || (e.target as Element).closest("[data-bar], .pj-linkmenu, .pj-link")) return;
    const box = canvas.current?.getBoundingClientRect();
    if (!box) return;
    const task = out.unscheduled[Math.floor((e.clientY - box.top) / ROW) - shown.length - 1];
    if (task) give(task, dayUnder(view, e.clientX - box.left));
  };

  if (!out.rows.length && !out.unscheduled.length) {
    return (
      <EmptyState title={tr("Nothing to place on a timeline")} icon="timeline">
        <p className="muted">{tr("Add tasks to this project, and give them dates.")}</p>
      </EmptyState>
    );
  }

  const decide = pending && plan ? { task: byId.get(pending.id), others: plan.changes.filter((c) => c.kind !== "dragged") } : null;
  const todayAt = dayAt(view, today);

  return (
    <div className="pj-time" onKeyDown={onKeys}>
      <div className="pj-time-bar" role="toolbar" aria-label={tr("Timeline")}>
        <div className="segmented" role="group" aria-label={tr("Zoom")}>
          {ZOOMS.map((z) => (
            <button key={z} type="button" aria-pressed={z === zoom} onClick={() => zoomTo(z)}>
              {ZOOM_NAMES[z]}
            </button>
          ))}
        </div>
        <Button size="sm" onClick={() => toToday(true)}>
          {tr("Today")}
        </Button>
        <label className="pj-check">
          <input type="checkbox" checked={path} onChange={(e) => setQuery({ path: e.target.checked ? "1" : null })} />
          {tr("Critical path")}
        </label>
        {canWrite && (
          <Button size="sm" variant="ghost" disabled={!past.length} onClick={undo} title={tr("Undo the last change (Ctrl or Cmd+Z)")}>
            <Undo2 size={14} aria-hidden="true" />
            {tr("Undo")}
          </Button>
        )}
        <Keys
          keys={[
            ["← →", "Move the bar a day (with Shift, a week)"],
            ["Alt + ← →", "Change when it ends"],
            ["Enter", "Open the task"],
            ["D W M Q", "Zoom to days, weeks, months, quarters"],
            ["+ −", "Zoom in or out"],
            ["T", "Go to today"],
            ["C", "Show the critical path"],
            ["Ctrl or ⌘ + Z", "Undo the last change"],
            ["Esc", "Let go of a bar, or cancel the move"],
          ]}
        />
        <span className="faint pj-time-hint">{canWrite ? "Drag a bar to move it, its ends to resize it, the dot to link it. The arrow keys work too." : "Open a task to see it beside the timeline."}</span>
      </div>
      {closed && <Alert tone="info">{tr("This project is")} {project.status?.toLowerCase()}{tr(". Its tasks cannot be changed until it is reopened.")}</Alert>}
      {tasks.total > tasks.rows.length && (
        <Alert tone="warning">
          {tr("The timeline shows the first {length} of {total} tasks.", { length: tasks.rows.length, total: tasks.total })} <Link to={`/e/Task?f.project=${project.id}`}>{tr("Open the list")}</Link> {tr("to see them all.")}
        </Alert>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {note}
      </p>
      <p className="sr-only" id="pj-time-help">
        {tr("Each bar is a task. Press Enter to open it. The left and right arrow keys move it by a day, with Shift by a week; with Alt they change when it ends. To make a task wait for another without dragging, open its page.")}
      </p>
      <div className="pj-gantt" data-ferrum-nocard="" ref={scroller} style={{ "--row": `${ROW}px` } as CSSProperties}>
        <div className="pj-gantt-head">
          <div className="pj-gl pj-gl-corner">{tr("Task")}</div>
          <div className="pj-scale" style={{ width }} aria-hidden="true">
            {[head.top, head.bottom].map((line, n) => (
              <div key={n} className="pj-scale-line">
                {line.map((t) => (
                  <span key={t.at} style={{ left: t.at * view.px, width: t.span * view.px }}>
                    {t.label}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="pj-gantt-body">
          <div className="pj-gl-col">
            {shown.map((r) => {
              const t = r.task;
              return (
                <div key={t.id} className="pj-gl pj-gl-row" data-open={open === t.id || undefined} style={{ paddingLeft: 6 + r.depth * 14 }}>
                  {r.kids > 0 ? (
                    <button
                      type="button"
                      className="pj-fold"
                      aria-expanded={!folded.has(t.id)}
                      aria-label={`${folded.has(t.id) ? "Show" : "Hide"} the ${r.kids} sub-tasks of ${t.subject}`}
                      onClick={() =>
                        setFolded((f) => {
                          const n = new Set(f);
                          if (!n.delete(t.id)) n.add(t.id);
                          return n;
                        })
                      }
                    >
                      {folded.has(t.id) ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                    </button>
                  ) : (
                    <span className="pj-fold" aria-hidden="true" />
                  )}
                  <button type="button" className="pj-gl-title" onClick={() => onOpen(t.id)} title={`${t.number ?? ""} ${t.subject ?? ""}`.trim()}>
                    {t.is_milestone && <Diamond size={11} role="img" aria-label={tr("Milestone")} className="pj-milestone-mark" />}
                    {t.subject}
                  </button>
                  {!r.span && canWrite && (
                    <button type="button" className="link-btn pj-schedule" onClick={() => give(t, today)} title={tr("Give it dates, starting today")}>
                      {tr("Schedule")}
                    </button>
                  )}
                  {r.span && <span className="pj-gl-dates faint">{r.span.start === r.span.end ? shortDay(r.span.end) : `${shortDay(r.span.start)} – ${shortDay(r.span.end)}`}</span>}
                </div>
              );
            })}
            {out.unscheduled.length > 0 && (
              <>
                <div className="pj-gl pj-gl-row pj-gl-group">{tr("Not scheduled")}</div>
                {out.unscheduled.map((t) => (
                  <div key={t.id} className="pj-gl pj-gl-row" data-open={open === t.id || undefined}>
                    <span className="pj-fold" aria-hidden="true" />
                    <button type="button" className="pj-gl-title" onClick={() => onOpen(t.id)}>
                      {t.is_milestone && <Diamond size={11} role="img" aria-label={tr("Milestone")} className="pj-milestone-mark" />}
                      {t.subject}
                    </button>
                    {canWrite && (
                      <button type="button" className="link-btn pj-schedule" onClick={() => give(t, today)} title={tr("Give it dates, starting today")}>
                        {tr("Schedule")}
                      </button>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
          <div
            className="pj-canvas"
            ref={canvas}
            style={{ width, height: rowsHigh * ROW }}
            role="group"
            aria-label={tr("Bars")}
            aria-describedby="pj-time-help"
            data-writable={canWrite || undefined}
            onClick={onEmpty}
          >
            {weekend.map((w) => (
              <span key={w.at} className="pj-weekend" style={{ left: w.at * view.px, width: w.span * view.px }} aria-hidden="true" />
            ))}
            {todayAt >= 0 && todayAt < view.days && <span className="pj-today-line" style={{ left: (todayAt + 0.5) * view.px }} aria-hidden="true" />}
            {out.unscheduled.length > 0 && <span className="pj-undated" style={{ top: (shown.length + 1) * ROW, height: out.unscheduled.length * ROW }} aria-hidden="true" />}
            {out.unscheduled.length > 0 && canWrite && (
              <div className="pj-undated-note" style={{ top: shown.length * ROW }}>
                <span className="faint">{tr("Click a row below to give that task dates, from the day you click.")}</span>
              </div>
            )}

            <svg className="pj-links" width={width} height={rowsHigh * ROW} aria-hidden="true">
              <defs>
                {(["", "-bad", "-hot"] as const).map((k) => (
                  <marker key={k} id={`pj-head${k}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                    <path d="M0,0 L8,4 L0,8 z" className={`pj-tip${k ? ` pj-tip${k}` : ""}`} />
                  </marker>
                ))}
              </defs>
              {lines.map((l) => {
                const a = middle(l.from);
                const b = middle(l.to);
                if (!a || !b) return null;
                const d = arrow(rightOf(a.row), a.y, leftOf(b.row), b.y, ROW);
                const hot = tight.has(l.from) && tight.has(l.to);
                return (
                  <g key={`${l.from}>${l.to}`} className="pj-link" data-broken={!l.ok || undefined} data-critical={hot || undefined}>
                    <path d={d} className="pj-link-line" markerEnd={`url(#pj-head${!l.ok ? "-bad" : hot ? "-hot" : ""})`} />
                    <path
                      d={d}
                      className="pj-link-hit"
                      onClick={(e) => {
                        const box = canvas.current?.getBoundingClientRect();
                        if (box) setMenu({ from: l.from, to: l.to, x: e.clientX - box.left, y: e.clientY - box.top });
                      }}
                    >
                      <title>
                        {byId.get(l.to)?.subject} {tr("waits for")} {byId.get(l.from)?.subject}
                        {l.ok ? "" : ": its dates overlap"}
                      </title>
                    </path>
                  </g>
                );
              })}
              {linking &&
                (() => {
                  const a = middle(linking.from);
                  return a ? <path d={`M${rightOf(a.row)},${a.y} L${linking.x},${linking.y}`} className="pj-link-line pj-link-new" /> : null;
                })()}
            </svg>

            {/* Where moved tasks were: a ghost under each, while the question is open or a bar is carried. */}
            {plan?.changes.map((c) => {
              const i = rowOf.get(c.id);
              if (!c.before || i === undefined) return null;
              return <span key={c.id} className="pj-ghost" style={{ left: dayAt(view, c.before.start) * view.px, width: length(c.before as Span) * view.px, top: i * ROW + 8, height: ROW - 16 }} aria-hidden="true" />;
            })}

            {shown.map((r, i) => {
              const t = r.task;
              const s = r.span;
              if (!s) return null;
              const own = !r.summary;
              const editable = canWrite && own;
              const late = !!t.exp_end_date && t.exp_end_date < today && t.status !== "Completed";
              const props = {
                "data-bar": t.id,
                "data-status": t.status ?? "Open",
                "data-late": late || undefined,
                "data-shift": shifted.get(t.id)?.kind,
                "data-critical": tight.has(t.id) || undefined,
                "data-open": open === t.id || undefined,
                "data-carried": drag?.id === t.id || undefined,
                role: "button",
                tabIndex: 0,
                "aria-label": `${t.number ?? ""} ${t.subject ?? ""}, ${s.start === s.end ? s.end : `${s.start} to ${s.end}`}${editable ? ". Arrow keys move it; Alt and the arrow keys change its end." : ""}`,
                onKeyDown: (e: KeyboardEvent<HTMLElement>) => onBarKey(e, r),
                onPointerDown: editable ? (e: PointerEvent<HTMLDivElement>) => onDown(e, r) : undefined,
                onPointerMove: editable ? onMove : undefined,
                onPointerUp: editable ? onUp : undefined,
                onPointerCancel: editable ? onCancel : undefined,
                onClick: editable ? undefined : () => onOpen(t.id),
              };
              if (t.is_milestone) {
                return (
                  <div key={t.id} {...props} className="pj-diamond" style={{ left: leftOf(r), top: i * ROW + ROW / 2 - 8 }} title={`${t.subject}: ${s.end}`}>
                    {editable && <span className="pj-dot" data-grip="link" aria-hidden="true" />}
                  </div>
                );
              }
              const wide = length(s) * view.px;
              return (
                <div key={t.id} {...props} className={`pj-bar${r.summary ? " pj-bar-summary" : ""}`} style={{ left: leftOf(r), width: wide, top: i * ROW + (r.summary ? 14 : 8), height: r.summary ? 8 : ROW - 16 }} title={`${t.subject}: ${s.start} – ${s.end}`}>
                  {!r.summary && <span className="pj-bar-fill" style={{ width: `${Math.max(0, Math.min(100, Number(t.progress ?? 0)))}%` }} />}
                  {editable && <span className="pj-grip pj-grip-start" data-grip="start" aria-hidden="true" />}
                  {editable && <span className="pj-grip pj-grip-end" data-grip="end" aria-hidden="true" />}
                  {editable && <span className="pj-dot" data-grip="link" aria-hidden="true" />}
                  <span className="pj-bar-text" data-out={wide < 90 || undefined}>
                    {t.subject}
                  </span>
                </div>
              );
            })}

            {menu && (
              <div className="pj-linkmenu card" style={{ left: Math.max(0, Math.min(menu.x, width - 230)), top: menu.y + 8 }} role="dialog" aria-label={tr("Link")}>
                <p>
                  <strong>{byId.get(menu.to)?.subject}</strong> {tr("waits for")} <strong>{byId.get(menu.from)?.subject}</strong>.
                </p>
                <div className="row">
                  {canWrite && (
                    <Button size="sm" variant="danger" onClick={() => removeLink(menu.from, menu.to)}>
                      {tr("Remove the link")}
                    </Button>
                  )}
                  <Button size="sm" onClick={() => setMenu(null)}>
                    {tr("Close")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      {decide?.task && plan && pending && (
        <div className="pj-decide card" role="alertdialog" aria-label={tr("Confirm the move")} aria-describedby="pj-decide-text">
          <p id="pj-decide-text">
            {pending.days === 0 ? (
              <>{tr("To keep the new link,")} {decide.others.length === 1 ? "1 task moves" : `${decide.others.length} tasks move`} later.</>
            ) : (
              <>
                {tr("Moving")} <strong>{decide.task.subject}</strong> {describeShift(pending)} {tr("also moves")} {decide.others.length === 1 ? "1 task" : `${decide.others.length} tasks`} {tr("linked to it:")} {decide.others.slice(0, 3).map((c) => byId.get(c.id)?.subject).join(", ")}
                {decide.others.length > 3 ? ", …" : ""}.
              </>
            )}
            {plan.skipped.length > 0 && <span className="faint"> {plan.skipped.length === 1 ? "1 linked task without dates stays." : `${plan.skipped.length} linked tasks without dates stay.`}</span>}
          </p>
          <div className="row">
            <Button variant="primary" size="sm" autoFocus onClick={() => commit(plan)}>
              {tr("Move")} {plan.changes.length === 1 ? "it" : `${plan.changes.length} tasks`}
            </Button>
            <Button size="sm" onClick={() => setPending(null)}>
              {tr("Cancel")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
