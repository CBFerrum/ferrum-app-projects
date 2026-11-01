// The screens drawn once, on the server's kind of render (no browser, no network), with the
// records they read already in hand: a screen that cannot draw what it was given fails here.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { Board } from "./Board";
import type { Project } from "./data";
import type { Task } from "./plan";
import { Timeline } from "./Timeline";

const all = { read: "all", write: "all", create: "all", delete: "all", submit: "all", cancel: "all", export: "all", import: "all" };
const project: Project = { id: "p1", project_name: "Website", status: "Open", start_date: "2026-11-01", end_date: "2026-12-20" };
const day = (d: number) => `2026-11-${String(d).padStart(2, "0")}`;
const task = (id: string, extra: Partial<Task>): Task => ({ id, version: 1, number: `TASK-${id}`, subject: `Task ${id}`, status: "Open", priority: "Medium", project: "p1", assigned_to: [], depends_on: [], ...extra });
const tasks: Task[] = [
  task("1", { subject: "Design", status: "Completed", exp_start_date: day(2), exp_end_date: day(6), rank: "1000.000000000", assigned_to: [{ user: "asha@acme.test" }] }),
  task("2", { subject: "Build", status: "Working", priority: "High", exp_start_date: day(9), exp_end_date: day(20), depends_on: [{ task: "1" }], assigned_to: [{ user: "asha@acme.test" }, { user: "ravi@acme.test" }] }),
  task("3", { subject: "Launch", exp_end_date: day(23), is_milestone: true, depends_on: [{ task: "2" }] }),
  task("4", { subject: "Wireframes", parent_task: "1", exp_start_date: day(2), exp_end_date: day(4), status: "Completed" }),
  task("5", { subject: "Someday", status: "Overdue" }),
];

function seeded(): QueryClient {
  const qc = new QueryClient();
  qc.setQueryData(["meta"], { version: 1, packages: [], modules: [], warnings: [], entities: [{ name: "Task", label: "Task", label_plural: "Tasks", kind: "master", submittable: false, permissions: all }] });
  qc.setQueryData(["me"], { tenant: "t", user: { id: "u1", email: "asha@acme.test", full_name: "Asha Rao", is_admin: false, roles: [] }, scopes: {}, packages: [], fiscal_year_start_month: 4, default_company: null });
  qc.setQueryData(["people"], { users: [{ id: "u1", full_name: "Asha Rao", email: "asha@acme.test" }, { id: "u2", full_name: "Ravi Kumar", email: "ravi@acme.test" }] });
  return qc;
}

const draw = (ui: React.ReactNode, at = "/") =>
  renderToStaticMarkup(
    <QueryClientProvider client={seeded()}>
      <MemoryRouter initialEntries={[at]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

describe("the board", () => {
  const board = (at = "/") => draw(<Board project={project} set={{ rows: tasks, total: tasks.length }} open={null} onOpen={() => {}} />, at);

  it("has a column for each status, Overdue because a task is in it, and a card in each", () => {
    const html = board();
    for (const s of ["Open", "Overdue", "Working", "Pending Review", "Completed"]) expect(html).toContain(`aria-label="${s}, `);
    for (const t of ["Design", "Build", "Launch", "Wireframes", "Someday"]) expect(html).toContain(t);
    expect(html).toContain("Add a task to Working");
    expect(html).not.toContain("Add a task to Overdue");
    expect(html).toContain("5 tasks");
  });

  it("shows what a card carries: a milestone, people, what it waits for", () => {
    const html = board();
    expect(html).toContain('aria-label="Milestone"');
    expect(html).toContain("Waits for TASK-2 Build"); // Launch waits for Build, which is under way
    expect(html).not.toContain("Waits for TASK-1 Design"); // Build waits for Design, which is done
  });

  it("groups into a lane per person with the nobody lane last, from the address", () => {
    const html = board("/?lanes=assignee");
    expect(html).toContain("Asha Rao");
    expect(html).toContain("Ravi Kumar");
    expect(html).toContain("Nobody");
  });

  it("filters from the address and says how many of how many", () => {
    const html = board("/?who=ravi%40acme.test");
    expect(html).toContain("1 of 5 tasks");
    expect(html).toContain("Clear the filter");
  });

  it("reads a closed project as read-only", () => {
    const html = draw(<Board project={{ ...project, status: "Completed" }} set={{ rows: tasks, total: 5 }} open={null} onOpen={() => {}} />);
    expect(html).toContain("This project is completed");
    expect(html).not.toContain("Add a task to");
  });

  it("says when the first tasks are all it shows", () => {
    expect(draw(<Board project={project} set={{ rows: tasks, total: 900 }} open={null} onOpen={() => {}} />)).toContain("first 500 of 900 tasks");
  });
});

describe("the timeline", () => {
  const line = (rows = tasks, at = "/") => draw(<Timeline project={project} set={{ rows, total: rows.length }} open={null} onOpen={() => {}} />, at);

  it("draws a bar for each dated task, a diamond for a milestone, and arrows for the links", () => {
    const html = line();
    for (const id of ["1", "2", "4"]) expect(html).toContain(`data-bar="${id}"`);
    expect(html).toContain('class="pj-diamond"');
    expect(html.match(/class="pj-link"/g)?.length).toBe(2);
    expect(html).toContain("Not scheduled");
    expect(html).toContain("Someday");
  });

  it("puts a sub-task under its parent and offers to fold it", () => {
    const html = line();
    expect(html).toContain("sub-tasks of Design");
  });

  it("marks a link whose dates overlap", () => {
    const html = line([tasks[0], { ...tasks[1], exp_start_date: day(5) }]);
    expect(html).toContain('data-broken="true"');
  });

  it("shows the critical path when asked", () => {
    expect(line(tasks, "/?path=1")).toContain('data-critical="true"');
  });

  it("is an empty state with nothing to place", () => {
    expect(line([])).toContain("Nothing to place on a timeline");
  });

  it("offers the zoom levels, and the one in the address is pressed", () => {
    const html = line(tasks, "/?zoom=month");
    expect(html.match(/aria-pressed="true"[^>]*>Month</)).not.toBeNull();
  });
});

// ── the other screens, with their sections already loaded ──

import { Route, Routes } from "react-router";
import { ProjectsHome } from "./Home";
import { MyWork } from "./MyWork";
import { Planning } from "./Planning";
import { ProjectPage } from "./Project";
import { TaskRoute } from "./Task";
import { todayIso } from "@ferrum/client";
import { weekStart } from "./days";

const field = (name: string, label: string, type: string, extra: object = {}) => ({ name, label, type, can_read: true, can_write: true, ...extra });
const taskMeta = {
  name: "Task",
  label: "Task",
  label_plural: "Tasks",
  kind: "master",
  title_field: "subject",
  submittable: false,
  permissions: all,
  fields: [field("subject", "Subject", "data"), field("status", "Status", "select", { options: ["Open", "Working", "Completed"] }), field("exp_end_date", "Expected End Date", "date")],
  form: [{ label: "Task", fields: ["subject", "status", "exp_end_date"] }],
  list: { columns: [], sort: "created_at desc" },
  actions: [],
  children: {},
};
const doc = { id: "t2", version: 3, number: "TASK-2", subject: "Build", status: "Working", priority: "High", project: "p1", exp_start_date: day(9), exp_end_date: day(20), expected_hours: "20", actual_hours: "6.5", depends_on: [{ id: "r1", task: "t1", subject: "Design" }], assigned_to: [{ id: "a1", user: "asha@acme.test" }], is_milestone: false, _titles: { project: "Website" } };

function loaded(): QueryClient {
  const qc = seeded();
  const put = (key: unknown[], data: unknown) => qc.setQueryData(key, data);
  put(["meta", "Task"], taskMeta);
  put(["peek", "Task", "t2"], doc);
  put(["projects", "task", "t2", "kids", ""], [{ id: "k1", version: 1, number: "TASK-6", subject: "Wire the form", status: "Completed", priority: "Medium", exp_end_date: day(12), assigned_to: [] }, { id: "k2", version: 1, number: "TASK-7", subject: "Wire the list", status: "Open", priority: "High", exp_end_date: day(1), assigned_to: [{ user: "ravi@acme.test" }] }]);
  put(["projects", "task", "t2", "waits", "t1"], [{ id: "t1", number: "TASK-1", subject: "Design", status: "Working", exp_end_date: day(6) }]);
  put(["projects", "task", "t2", "blocks", ""], [{ id: "t3", number: "TASK-3", subject: "Launch", status: "Open", exp_end_date: day(23) }]);
  put(["projects", "task", "t2", "time", ""], [{ id: "ts1", user: "asha@acme.test", docstatus: 1, time_logs: [{ task: "t2", hours: "6.5", from_time: `${day(10)}T09:00:00Z`, description: "First pass" }] }]);
  put(["projects", "task", "t2", "issues", ""], [{ id: "i1", title: "Form loses data", severity: "High", status: "Open" }]);
  put(["projects", "task", "t2", "audit", ""], [{ id: 1, at: `${day(2)}T09:00:00Z`, action: "create", actor_name: "Asha Rao" }, { id: 2, at: `${day(9)}T09:00:00Z`, action: "update", actor_name: "Asha Rao", diff: { status: ["Open", "Working"] } }]);
  put(["projects", "task", "t2", "comments", ""], [{ id: "c1", body: "Starting on the form first", author: "Asha Rao", created_at: `${day(9)}T10:00:00Z` }]);
  return qc;
}

const page = (qc: QueryClient, ui: React.ReactNode, at: string, path: string) =>
  renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path={path} element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe("a task's page", () => {
  const html = page(loaded(), <TaskRoute />, "/t/t2", "/t/:id");

  it("says where the task stands, in words and in steps", () => {
    for (const t of ["TASK-2", "Build", "Working", "Mark complete", "Pending Review"]) expect(html).toContain(t);
    expect(html).toContain('aria-current="step"');
  });

  it("lists its sub-tasks with how many are done", () => {
    expect(html).toContain("Sub-tasks, 1 of 2 done");
    expect(html).toContain("Wire the list");
  });

  it("says what it waits for, warns that it cannot start, and what waits for it", () => {
    expect(html).toContain("Design");
    expect(html).toContain("Launch");
  });

  it("counts the time logged against the estimate, and lists the issues", () => {
    expect(html).toContain("6.5 h");
    expect(html).toContain("of 20 h expected");
    expect(html).toContain("Form loses data");
  });

  it("tells what happened, newest first, with the comment", () => {
    expect(html.indexOf("Starting on the form first")).toBeGreaterThan(-1);
    expect(html).toContain("Status: Open → Working");
    expect(html).toContain("Task created");
    expect(html.indexOf("Status: Open → Working")).toBeLessThan(html.indexOf("Task created"));
  });
});

describe("home, a project and a plate", () => {
  it("home lists the open projects with what is late", () => {
    const qc = seeded();
    qc.setQueryData(["meta"], { version: 1, packages: [], modules: [], warnings: [], entities: [{ name: "Project", label: "Project", label_plural: "Projects", kind: "master", submittable: false, permissions: all }] });
    qc.setQueryData(["projects", "open"], { rows: [{ id: "p1", project_name: "Website", status: "Open", end_date: day(30), proj_percent_complete: "40", proj_project_manager: "asha@acme.test", proj_priority: "High", _titles: { customer: "Acme" } }] });
    qc.setQueryData(["projects", "overdue"], { rows: [{ id: "t5", project: "p1" }, { id: "t6", project: "p1" }] });
    qc.setQueryData(["projects", "my-tasks", "asha@acme.test"], { rows: [{ id: "t2", subject: "Build", status: "Working", exp_end_date: day(1), _titles: { project: "Website" } }], total: 1 });
    const html = page(qc, <ProjectsHome />, "/", "/");
    for (const t of ["Website", "2 late", "Acme", "My work", "Build"]) expect(html).toContain(t);
  });

  it("a project opens on how it stands", () => {
    const qc = seeded();
    qc.setQueryData(["projects", "project", "p1"], { ...project, proj_percent_complete: "40", proj_actual_hours: "60", proj_estimated_hours: "50", proj_costing_amount: "4000", budget: "10000", proj_billed_amount: "2500", _titles: { currency: "INR", customer: "Acme" } });
    qc.setQueryData(["projects", "tasks", "p1"], { rows: tasks, total: tasks.length });
    qc.setQueryData(["projects", "watch", "p1"], { risks: 3, issues: 0, changes: 1 });
    const html = page(qc, <ProjectPage />, "/p/p1", "/p/:id");
    for (const t of ["Website", "How the project stands", "60.0 h", "of 50 h", "Open risks", "Changes to decide", "Board", "Timeline", "Time"]) expect(html).toContain(t);
    expect(html).toContain("pj-late"); // 60 h of 50
  });

  it("my work groups by when it is due, with the week beside it", () => {
    const qc = seeded();
    const today = todayIso();
    qc.setQueryData(["projects", "plate", "asha@acme.test", "tasks"], {
      rows: [
        { id: "a", version: 1, number: "T-1", subject: "Overdue thing", status: "Open", priority: "Urgent", project: "p1", exp_end_date: "2000-01-01", expected_hours: "4", actual_hours: "1", _titles: { project: "Website" } },
        { id: "b", version: 1, number: "T-2", subject: "Whenever", status: "Working", project: "p1", _titles: { project: "Website" } },
      ],
      total: 2,
    });
    qc.setQueryData(["projects", "plate", "asha@acme.test", "planned", weekStart(today)], [{ id: "al1", person: "asha@acme.test", from_date: weekStart(today), to_date: weekStart(today), hours_per_day: "6", _titles: { project: "Website" } }]);
    qc.setQueryData(["projects", "plate", "asha@acme.test", "logged", weekStart(today)], 12.5);
    const html = page(qc, <MyWork />, "/my", "/my");
    for (const t of ["Your work", "Overdue", "No date", "Overdue thing", "3 h to go", "This week", "12.5 h"]) expect(html).toContain(t);
    expect(html).toContain("By project");
  });

  it("planning shows the grid, and the portfolios", () => {
    const qc = seeded();
    qc.setQueryData(["meta"], { version: 1, packages: [], modules: [], warnings: [], entities: [{ name: "ResourceAllocation", label: "Resource Allocation", label_plural: "Resource Allocations", kind: "master", submittable: false, permissions: all }] });
    const monday = weekStart(todayIso());
    qc.setQueryData(["projects", "workload", monday, 8], { rows: [{ person: "asha@acme.test", week: monday, hours: "44", capacity: 40, over: true }, { person: "ravi@acme.test", week: monday, hours: "10", capacity: 40, over: false }] });
    let html = page(qc, <Planning />, "/plan", "/plan");
    for (const t of ["Planning", "Asha Rao", "Ravi Kumar", "44", "110%", "1 person is", "Over the week", "Export CSV"]) expect(html).toContain(t);
    qc.setQueryData(["projects", "portfolios"], [{ id: "pf1", portfolio_name: "Client work" }]);
    qc.setQueryData(["projects", "standing", ""], [{ project: "Website", status: "Open", tasks: 10, completed: 4, overdue: 2, progress: "40", open_risks: 1, open_issues: 0 }]);
    qc.setQueryData(["projects", "named"], [{ id: "p1", project_name: "Website", end_date: day(30), proj_project_manager: "asha@acme.test" }]);
    html = page(qc, <Planning />, "/plan?tab=portfolios", "/plan");
    for (const t of ["Client work", "Website", "4/10", "Every project"]) expect(html).toContain(t);
  });

  it("planning says it is for planners when the person cannot read everyone's allocations", () => {
    const qc = seeded();
    qc.setQueryData(["meta"], { version: 1, packages: [], modules: [], warnings: [], entities: [{ name: "ResourceAllocation", label: "Resource Allocation", label_plural: "Resource Allocations", kind: "master", submittable: false, permissions: { ...all, read: "own" } }] });
    expect(page(qc, <Planning />, "/plan", "/plan")).toContain("Planning is for people who plan");
  });
});
