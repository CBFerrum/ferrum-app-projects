// Planning, for people who plan others' time: who is booked how much in the weeks ahead (the
// workload report's figures, as a heat grid people by weeks), the allocations behind each week to
// change, add or remove, and how the projects of a portfolio stand. Over-allocation is shown, not
// refused: planners often know better.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type KeyboardEvent, useCallback, useMemo, useState } from "react";
import { Link } from "react-router";
import { api, ApiError, docPath, errorMessage, newKey, saveBlob, todayIso, t as tr, isolate } from "@ferrum/client";
import { Alert, Badge, Button, confirmDialog, Dialog, EmptyState, ErrorState, Field, Icon, Spinner, statusTone, Tabs, TabPanel, useLiveEntity, useShellTitle, placed } from "@ferrum/kit";
import { LinkInput, useMe, useMetaIndex, usePeople } from "@ferrum/records";
import { Progress } from "./bits";
import { list, type Project, useNames, useQueryState } from "./data";
import { addDays } from "./days";
import { Nav, usePlanner } from "./Nav";
import { type Allocation, type Cell, grid, hoursIn, hoursText, type Level, type Person, touches, weekEnd, weekLabel, type WorkloadRow, weeksFrom } from "./workload";

const LEVELS: Record<Level, string> = { get free() { return tr("Nothing planned"); }, get ok() { return tr("Up to 80 % of the week"); }, busy: "80 to 100 %", get over() { return tr("Over the week"); } };
const TABS = [
  { id: "capacity", get label() { return tr("Capacity"); } },
  { id: "portfolios", get label() { return tr("Portfolios"); } },
];

interface Report<R> {
  rows: R[];
}

// ── the company the figures are for ──

/** Reports run for one company: the person's own, unless there are several and they choose another. */
function useCompany(): { id: string | undefined; choices: { id: string; name: string }[]; choose: (id: string) => void } {
  const me = useMe().data;
  const [sp, setQuery] = useQueryState();
  const q = useQuery({
    queryKey: ["projects", "companies"],
    queryFn: ({ signal }) => list<{ id: string; company_name?: string }>("Company", { fields: "company_name", sort: "company_name asc", limit: 50 }, signal).then((r) => r.rows),
    retry: false,
  });
  const choices = (q.data ?? []).map((c) => ({ id: c.id, name: c.company_name ?? "Company" }));
  const asked = sp.get("company");
  const id = asked && choices.some((c) => c.id === asked) ? asked : (me?.default_company ?? undefined);
  return { id, choices, choose: (value) => setQuery({ company: value || null }) };
}

function CompanyPick({ company }: { company: ReturnType<typeof useCompany> }) {
  if (company.choices.length < 2) return null;
  return (
    <label className="pj-tools-pick">
      <span className="faint">{tr("Company")}</span>
      <select className="select pj-select" value={company.id ?? ""} onChange={(e) => company.choose(e.target.value)}>
        {!company.id && <option value="">{tr("Choose a company")}</option>}
        {company.choices.map((c) => (
          <option key={c.id} value={c.id}>
            {isolate(c.name)}
          </option>
        ))}
      </select>
    </label>
  );
}

// ── an allocation, added or changed ──

interface Draft {
  id?: string;
  version?: number;
  person: string;
  project: string | null;
  task: string | null;
  from_date: string;
  to_date: string;
  hours_per_day: string;
  titles?: Record<string, string>;
}

function AllocationDialog({ draft, onClose, onSaved }: { draft: Draft; onClose: () => void; onSaved: () => void }) {
  const people = usePeople().data?.users ?? [];
  const [form, setForm] = useState(draft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (change: Partial<Draft>) => setForm((f) => ({ ...f, ...change }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setFailure(null);
    const body = { person: form.person, project: form.project, task: form.task, from_date: form.from_date, to_date: form.to_date, hours_per_day: form.hours_per_day };
    try {
      if (form.id) await api.patch(docPath("ResourceAllocation", form.id), body, { ifMatch: form.version });
      else await api.post("/api/v1/ResourceAllocation", body, { idempotencyKey: newKey() });
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.fields.length) {
        setErrors(Object.fromEntries(err.fields.map((f) => [f.field, f.message])));
        setFailure(err.message);
      } else setFailure(errorMessage(err));
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!form.id || !(await confirmDialog({ title: tr("Remove this allocation?"), message: tr("The person is no longer planned for this time."), confirmLabel: tr("Remove it"), danger: true }))) return;
    try {
      await api.del(docPath("ResourceAllocation", form.id), { ifMatch: form.version });
      onSaved();
      onClose();
    } catch (err) {
      setFailure(errorMessage(err));
    }
  };
  return (
    <Dialog open onClose={onClose} title={form.id ? tr("Change the allocation") : tr("Plan someone onto a project")}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        {failure && <Alert tone="error">{isolate(failure)}</Alert>}
        <Field label={tr("Person")} htmlFor="al-person" required error={errors.person}>
          <select id="al-person" className="select" required value={form.person} onChange={(e) => set({ person: e.target.value })}>
            <option value="">{tr("Choose someone")}</option>
            {people.map((p) => (
              <option key={p.id} value={p.email}>
                {p.full_name || p.email}
              </option>
            ))}
          </select>
        </Field>
        <Field label={tr("Project")} htmlFor="al-project" required error={errors.project}>
          <LinkInput to="Project" id="al-project" value={form.project} title={form.titles?.project} required onChange={(id) => set({ project: id, task: id === form.project ? form.task : null })} />
        </Field>
        <Field label={tr("Task")} htmlFor="al-task" hint={tr("Optional: what they will be working on.")} error={errors.task}>
          <LinkInput to="Task" id="al-task" value={form.task} title={form.titles?.task} disabled={!form.project} linkFilters={form.project ? { project: form.project } : undefined} onChange={(id) => set({ task: id })} />
        </Field>
        <div className="pj-fields">
          <Field label={tr("From")} htmlFor="al-from" required error={errors.from_date}>
            <input id="al-from" className="input" type="date" required value={form.from_date} onChange={(e) => set({ from_date: e.target.value, to_date: form.to_date < e.target.value ? e.target.value : form.to_date })} />
          </Field>
          <Field label={tr("To")} htmlFor="al-to" required error={errors.to_date}>
            <input id="al-to" className="input" type="date" required min={form.from_date} value={form.to_date} onChange={(e) => set({ to_date: e.target.value })} />
          </Field>
          <Field label={tr("Hours a day")} htmlFor="al-hours" required error={errors.hours_per_day}>
            <input id="al-hours" className="input" type="number" inputMode="decimal" step="0.25" min="0.25" max="24" required value={form.hours_per_day} onChange={(e) => set({ hours_per_day: e.target.value })} />
          </Field>
        </div>
        <div className="row pj-dialog-foot">
          {form.id && (
            <Button variant="danger" onClick={() => void remove()}>
              {tr("Remove")}
            </Button>
          )}
          <span className="spacer" />
          <Button onClick={onClose}>{tr("Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {tr("Save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const draftOf = (a: Allocation): Draft => ({ id: a.id, version: a.version, person: a.person, project: a.project ?? null, task: a.task ?? null, from_date: a.from_date, to_date: a.to_date, hours_per_day: String(a.hours_per_day), titles: a._titles });

// ── one person's week ──

function Drawer({ person, week, name, onClose, onEdit, onAdd }: { person: string; week: string; name: string; onClose: () => void; onEdit: (a: Allocation) => void; onAdd: () => void }) {
  const q = useQuery({
    queryKey: ["projects", "allocations", person, week],
    queryFn: ({ signal }) =>
      list<Allocation>("ResourceAllocation", { titles: true, filters: JSON.stringify([["person", "=", person], ["from_date", "<=", weekEnd(week)], ["to_date", ">=", week]]), sort: "from_date asc", fields: "person,project,task,from_date,to_date,hours_per_day,version", limit: 100 }, signal).then((r) => r.rows),
  });
  const rows = (q.data ?? []).filter((a) => touches(a, week));
  const total = rows.reduce((n, a) => n + hoursIn(a, week, weekEnd(week)), 0);
  return (
    <aside className="peek pj-drawer" aria-label={tr("{name}, week of {week}", { name, week: weekLabel(week) })} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <header className="peek-head">
        <div className="peek-title">
          <h2>{isolate(name)}</h2>
          <span className="faint">{isolate(weekLabel(week))}</span>
        </div>
        <button type="button" className="icon-btn" aria-label={tr("Close")} title={tr("Close (Esc)")} onClick={onClose}>
          <Icon name="x" size={15} />
        </button>
      </header>
      <div className="peek-body">
        {q.error ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} title={tr("The allocations cannot be shown")} />
        ) : !q.data ? (
          <Spinner label={tr("Loading the allocations")} />
        ) : (
          <>
            <p className="pj-hours">
              <strong>{isolate(hoursText(total))}</strong> <span className="faint">{tr("planned this week")}</span>
            </p>
            {!rows.length && <p className="muted">{placed(tr("Nothing is planned for {p1} this week."), { p1: isolate(name.split(" ")[0]) })}</p>}
            <ul className="pj-lines">
              {rows.map((a) => (
                <li key={a.id}>
                  <span className="pj-line-title">
                    {a._titles?.project ?? tr("Project")}
                    {a.task && <span className="faint"> · {a._titles?.task ?? tr("Task")}</span>}
                    <span className="faint pj-line-sub">
                      {isolate(a.from_date)} – {isolate(a.to_date)} · {isolate(hoursText(Number(a.hours_per_day)))} {tr("a day ·")} {isolate(hoursText(hoursIn(a, week, weekEnd(week))))} {tr("this week")}
                    </span>
                  </span>
                  <Button size="sm" onClick={() => onEdit(a)} aria-label={tr("Change the allocation to {value}", { value: a._titles?.project ?? tr("the project") })}>
                    {tr("Change")}
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
        <p>
          <Button variant="primary" icon="plus" onClick={onAdd}>
            {placed(tr("Plan {p1} onto a project"), { p1: isolate(name.split(" ")[0]) })}
          </Button>
        </p>
      </div>
    </aside>
  );
}

// ── the grid ──

const percent = (c: Cell) => Math.round((c.hours / (c.capacity || 1)) * 100);

function Heat({ weeks, people, totals, nameOf, selected, onOpen }: { weeks: string[]; people: Person[]; totals: Cell[]; nameOf: (email: string) => string; selected: { person: string; week: string } | null; onOpen: (person: string, week: string) => void }) {
  // One cell of the grid is in the tab order; the arrow keys move it, and Enter opens the cell.
  const [cur, setCur] = useState<[number, number]>([0, 0]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    const r = Number(el.dataset.r);
    const c = Number(el.dataset.c);
    if (Number.isNaN(r)) return;
    const to = e.key === "ArrowRight" ? [r, c + 1] : e.key === "ArrowLeft" ? [r, c - 1] : e.key === "ArrowDown" ? [r + 1, c] : e.key === "ArrowUp" ? [r - 1, c] : null;
    if (!to) return;
    e.preventDefault();
    e.currentTarget.querySelector<HTMLElement>(`[data-r="${to[0]}"][data-c="${to[1]}"]`)?.focus();
  };
  return (
    <div className="pj-heat" role="grid" aria-label={tr("Hours planned by person and week")} style={{ "--weeks": weeks.length } as React.CSSProperties} onKeyDown={onKeyDown}>
      <div role="row" className="pj-heat-row pj-heat-head">
        <span role="columnheader" className="pj-heat-who">
          {tr("Person")}
        </span>
        {weeks.map((w) => (
          <span key={w} role="columnheader" className="pj-heat-week" title={tr("Week of {w}", { w: weekLabel(w) })}>
            {isolate(weekLabel(w))}
          </span>
        ))}
      </div>
      {people.map((p, r) => (
        <div key={p.email} role="row" className="pj-heat-row">
          <span role="rowheader" className="pj-heat-who" title={p.email}>
            {isolate(nameOf(p.email))}
          </span>
          {p.cells.map((c, i) => (
            <button
              key={c.week}
              type="button"
              role="gridcell"
              className="pj-heat-cell"
              data-level={c.level}
              data-r={r}
              data-c={i}
              data-selected={(selected?.person === p.email && selected.week === c.week) || undefined}
              tabIndex={cur[0] === r && cur[1] === i ? 0 : -1}
              aria-label={(c.hours ? tr("{value}, week of {value2}: {value1} of {capacity}, {value5} per cent. {value4}.", { value: nameOf(p.email), value2: weekLabel(c.week), value4: LEVELS[c.level], value1: hoursText(c.hours), capacity: c.capacity, value5: percent(c) }) : tr("{value}, week of {value2}: nothing planned. {value4}.", { value: nameOf(p.email), value2: weekLabel(c.week), value4: LEVELS[c.level] }))}
              onClick={() => onOpen(p.email, c.week)}
              onFocus={() => setCur([r, i])}
            >
              {c.hours > 0 ? hoursText(c.hours).replace(" h", "") : ""}
              {c.hours > 0 && <small>{percent(c)}%</small>}
            </button>
          ))}
        </div>
      ))}
      <div role="row" className="pj-heat-row pj-heat-total">
        <span role="rowheader" className="pj-heat-who">
          {tr("Team")}
        </span>
        {totals.map((c) => (
          <span key={c.week} role="gridcell" className="pj-heat-cell" data-level={c.level} title={tr("{value} of {value2}", { value: hoursText(c.hours), value2: hoursText(c.capacity) })}>
            {c.hours > 0 ? hoursText(c.hours).replace(" h", "") : ""}
            {c.hours > 0 && <small>{percent(c)}%</small>}
          </span>
        ))}
      </div>
    </div>
  );
}

function Capacity({ company }: { company: ReturnType<typeof useCompany> }) {
  const qc = useQueryClient();
  const names = useNames();
  const everyone = usePeople().data?.users ?? [];
  const [sp, setQuery] = useQueryState();
  const today = todayIso();
  const first = weeksFrom(sp.get("from") ?? today, 1)[0];
  const count = sp.get("weeks") === "12" ? 12 : 8;
  const all = sp.get("all") === "1";
  const weeks = useMemo(() => weeksFrom(first, count), [first, count]);
  const [picked, setPicked] = useState<{ person: string; week: string } | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);

  const q = useQuery({
    queryKey: ["projects", "workload", company.id ?? "", weeks[0], count],
    queryFn: ({ signal }) => api.get<Report<WorkloadRow>>("/api/reports/workload", { company: company.id, from_date: weeks[0], to_date: weekEnd(weeks[count - 1]) }, signal),
  });
  useLiveEntity("ResourceAllocation", useCallback(() => void qc.invalidateQueries({ queryKey: ["projects"] }), [qc]));
  const g = useMemo(() => grid(q.data?.rows ?? [], weeks, all ? everyone.map((p) => p.email) : [], names), [q.data, weeks, all, everyone, names]);
  const saved = () => void qc.invalidateQueries({ queryKey: ["projects"] });
  const shift = (days: number) => setQuery({ from: addDays(first, days) === weeksFrom(today, 1)[0] ? null : addDays(first, days) });
  const over = g.people.filter((p) => p.cells.some((c) => c.level === "over")).length;

  const download = () => {
    const rows = [["Person", ...weeks], ...g.people.map((p) => [names(p.email), ...p.cells.map((c) => String(c.hours))])];
    saveBlob(new Blob([rows.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(",")).join("\n")], { type: "text/csv" }), "workload.csv");
  };

  return (
    <div className="pj-capacity" data-drawer={picked ? "" : undefined}>
      <div className="pj-capacity-main">
        <div className="pj-tools" role="toolbar" aria-label={tr("Weeks shown")}>
          <CompanyPick company={company} />
          <Button size="sm" icon="left" aria-label={tr("Earlier weeks")} onClick={() => shift(-7 * count)} />
          <Button size="sm" icon="chevronRight" aria-label={tr("Later weeks")} onClick={() => shift(7 * count)} />
          <Button size="sm" onClick={() => setQuery({ from: null })}>
            {tr("This week")}
          </Button>
          <div className="segmented" role="group" aria-label={tr("How many weeks")}>
            {[8, 12].map((n) => (
              <button key={n} type="button" aria-pressed={n === count} onClick={() => setQuery({ weeks: n === 8 ? null : String(n) })}>
                {tr("{n} weeks", { n })}
              </button>
            ))}
          </div>
          <label className="pj-check">
            <input type="checkbox" checked={all} onChange={(e) => setQuery({ all: e.target.checked ? "1" : null })} />
            {tr("Include people with nothing planned")}
          </label>
          <span className="pj-tools-gap" />
          <Button size="sm" onClick={download} disabled={!g.people.length}>
            {tr("Export CSV")}
          </Button>
          <Button size="sm" variant="primary" icon="plus" onClick={() => setEditing({ person: "", project: null, task: null, from_date: today, to_date: addDays(today, 4), hours_per_day: "8" })}>
            {tr("Plan someone")}
          </Button>
        </div>
        {q.error ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} title={tr("The workload cannot be shown")} />
        ) : !q.data ? (
          <Spinner label={tr("Loading the workload")} />
        ) : !g.people.length ? (
          <EmptyState title={tr("Nobody is planned in these weeks")} icon="calendar">
            <p className="muted">{tr("Plan someone onto a project to see how full their weeks are.")}</p>
          </EmptyState>
        ) : (
          <>
            <p className="faint" aria-live="polite">
              {over > 0 ? <strong className="pj-late">{(over === 1 ? tr("1 person is booked beyond a week.") : tr("{over} people are booked beyond a week.", { over }))}</strong> : tr("Nobody is booked beyond a week.")} {tr("A week is 40 hours; weekends are not counted.")}
            </p>
            <Heat weeks={weeks} people={g.people} totals={g.totals} nameOf={names} selected={picked} onOpen={(person, week) => setPicked({ person, week })} />
            <ul className="pj-legend" aria-label={tr("Key")}>
              {(Object.keys(LEVELS) as Level[]).map((l) => (
                <li key={l}>
                  <span className="pj-swatch" data-level={l} /> {isolate(LEVELS[l])}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      {picked && (
        <Drawer
          person={picked.person}
          week={picked.week}
          name={names(picked.person)}
          onClose={() => setPicked(null)}
          onEdit={(a) => setEditing(draftOf(a))}
          onAdd={() => setEditing({ person: picked.person, project: null, task: null, from_date: picked.week, to_date: addDays(picked.week, 4), hours_per_day: "8" })}
        />
      )}
      {editing && <AllocationDialog draft={editing} onClose={() => setEditing(null)} onSaved={saved} />}
    </div>
  );
}

// ── portfolios ──

interface Standing {
  project: string;
  status?: string | null;
  tasks: number;
  completed: number;
  overdue: number;
  progress: string | number;
  open_risks: number;
  open_issues: number;
}

const attention = (r: Standing) => r.overdue * 100 + r.open_risks * 10 + r.open_issues;

function Portfolios({ company }: { company: ReturnType<typeof useCompany> }) {
  const [sp, setQuery] = useQueryState();
  const chosen = sp.get("portfolio") ?? "";
  const portfolios = useQuery({
    queryKey: ["projects", "portfolios"],
    queryFn: ({ signal }) => list<{ id: string; portfolio_name?: string; owner_email?: string }>("Portfolio", { fields: "portfolio_name,owner_email", sort: "portfolio_name asc", limit: 100 }, signal).then((r) => r.rows),
  });
  const standing = useQuery({
    queryKey: ["projects", "standing", company.id ?? "", chosen],
    queryFn: ({ signal }) => api.get<Report<Standing>>("/api/reports/portfolio_overview", { company: company.id, portfolio: chosen }, signal).then((r) => r.rows),
  });
  const projects = useQuery({
    queryKey: ["projects", "named"],
    queryFn: ({ signal }) => list<Project>("Project", { fields: "project_name,end_date,proj_project_manager,proj_priority", limit: 500 }, signal).then((r) => r.rows),
  });
  // The report names projects; a name that two projects share links nowhere.
  const byName = useMemo(() => {
    const seen = new Map<string, Project | null>();
    for (const p of projects.data ?? []) seen.set(p.project_name ?? "", seen.has(p.project_name ?? "") ? null : p);
    return seen;
  }, [projects.data]);
  const rows = useMemo(() => [...(standing.data ?? [])].sort((a, b) => attention(b) - attention(a) || a.project.localeCompare(b.project)), [standing.data]);
  const sum = rows.reduce((n, r) => ({ tasks: n.tasks + r.tasks, done: n.done + r.completed, overdue: n.overdue + r.overdue, risks: n.risks + r.open_risks, issues: n.issues + r.open_issues }), { tasks: 0, done: 0, overdue: 0, risks: 0, issues: 0 });
  const picked = portfolios.data?.find((p) => p.id === chosen);
  return (
    <div className="stack">
      <div className="pj-tools" role="toolbar" aria-label={tr("Portfolio")}>
        <CompanyPick company={company} />
        <label className="pj-tools-pick">
          <span className="faint">{tr("Portfolio")}</span>
          <select className="select pj-select" value={chosen} onChange={(e) => setQuery({ portfolio: e.target.value || null })}>
            <option value="">{tr("Every project")}</option>
            {(portfolios.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {isolate(p.portfolio_name ?? "")}
              </option>
            ))}
          </select>
        </label>
        <span className="pj-tools-gap" />
        {picked && (
          <Link className="btn btn-md" to={`/e/Portfolio/${picked.id}`}>
            {tr("Edit this portfolio")}
          </Link>
        )}
        <Link className="btn btn-md" to="/e/Portfolio/new">
          {tr("New portfolio")}
        </Link>
      </div>
      {standing.error ? (
        <ErrorState error={standing.error} onRetry={() => void standing.refetch()} title={tr("The portfolio cannot be shown")} />
      ) : !standing.data ? (
        <Spinner label={tr("Loading the portfolio")} />
      ) : !rows.length ? (
        <EmptyState title={chosen ? tr("No projects in this portfolio") : tr("No projects yet")} icon="board">
          {picked ? <Link to={`/e/Portfolio/${picked.id}`}>{tr("Add projects to it")}</Link> : <Link to="/e/Project/new">{tr("Start a project")}</Link>}
        </EmptyState>
      ) : (
        <>
          <section className="pj-tiles" aria-label={tr("Summary")}>
            <div className="pj-tile">
              <span className="pj-tile-label">{tr("Projects")}</span>
              <span className="pj-tile-value">{rows.length}</span>
            </div>
            <div className="pj-tile">
              <span className="pj-tile-label">{tr("Tasks done")}</span>
              <span className="pj-tile-value">
                {sum.done} <span className="faint">{tr("of {tasks}", { tasks: sum.tasks })}</span>
              </span>
            </div>
            <div className="pj-tile">
              <span className="pj-tile-label">{tr("Overdue")}</span>
              <span className={`pj-tile-value${sum.overdue ? " pj-late" : ""}`}>{sum.overdue}</span>
            </div>
            <div className="pj-tile">
              <span className="pj-tile-label">{tr("Open risks")}</span>
              <span className="pj-tile-value">{sum.risks}</span>
            </div>
            <div className="pj-tile">
              <span className="pj-tile-label">{tr("Open issues")}</span>
              <span className="pj-tile-value">{sum.issues}</span>
            </div>
          </section>
          <div className="pj-table-wrap" data-ferrum-nocard="">
            <table className="pj-table">
              <caption className="sr-only">{tr("Projects, the ones needing attention first")}</caption>
              <thead>
                <tr>
                  <th>{tr("Project")}</th>
                  <th>{tr("Status")}</th>
                  <th>{tr("Progress")}</th>
                  <th className="num">{tr("Tasks done")}</th>
                  <th className="num">{tr("Overdue")}</th>
                  <th className="num">{tr("Risks")}</th>
                  <th className="num">{tr("Issues")}</th>
                  <th>{tr("Due")}</th>
                  <th>{tr("Manager")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const p = byName.get(r.project);
                  return (
                    <tr key={r.project}>
                      <td>{p ? <Link to={`/p/${p.id}`}>{isolate(r.project)}</Link> : r.project}</td>
                      <td>
                        <Badge tone={statusTone(r.status)}>{isolate(r.status ?? "")}</Badge>
                      </td>
                      <td>
                        <Progress value={r.progress} label={tr("{project} complete", { project: r.project })} />
                      </td>
                      <td className="num">
                        {r.completed}/{r.tasks}
                      </td>
                      <td className={`num${r.overdue ? " pj-late" : ""}`}>{r.overdue}</td>
                      <td className="num">{r.open_risks}</td>
                      <td className="num">{r.open_issues}</td>
                      <td>{p?.end_date ?? ""}</td>
                      <td>{p?.proj_project_manager ?? ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export function Planning() {
  useShellTitle(tr("Planning"));
  const planner = usePlanner();
  const loaded = !!useMetaIndex().data;
  const [sp, setQuery] = useQueryState();
  const tab = sp.get("tab") === "portfolios" ? "portfolios" : "capacity";
  const company = useCompany();
  return (
    <div className="pj-page pj-planning">
      <header className="pj-head-row">
        <Nav />
      </header>
      {loaded && !planner ? (
        <EmptyState title={tr("Planning is for people who plan others' time")} icon="alert">
          <p className="muted">{tr("Ask an administrator for the Projects Manager role.")}</p>
        </EmptyState>
      ) : (
        <>
          <div className="page-head">
            <div>
              <h1 className="page-title">{tr("Planning")}</h1>
              <p className="page-sub">{tr("Who is booked when, and how the portfolios stand.")}</p>
            </div>
          </div>
          <Tabs id="pl" value={tab} onChange={(t) => setQuery({ tab: t === "capacity" ? null : t, from: null })} tabs={TABS} />
          <TabPanel id="pl" tab={tab}>
            {tab === "capacity" ? <Capacity company={company} /> : <Portfolios company={company} />}
          </TabPanel>
        </>
      )}
    </div>
  );
}
