import { describe, expect, it } from "vitest";
import { boardModel, dropAllowed, dropPlan, filterParams, findCard, focusMove, keyMove, matches, NO_FILTERS, NOBODY, readFilters, readLanes, readOrder, type BoardModel, type Filters } from "./kanban";
import { assignees, blockers, late, mark, subtaskCounts, type Task } from "./plan";

const today = "2026-11-10";
const ctx = { me: "asha@acme.test", today };
const t = (id: string, extra: Partial<Task> = {}): Task => ({ id, number: id, status: "Open", ...extra });
const who = (...users: string[]) => users.map((user) => ({ user }));
const keys = (model: BoardModel, status: string, lane = "") => model.lanes.find((l) => l.id === lane)!.cells.find((c) => c.status === status)!.cards.map((c) => c.task.id);

describe("the board's columns", () => {
  it("puts tasks in their status, Overdue only when used, Cancelled never", () => {
    const m = boardModel([t("a"), t("b", { status: "Working" }), t("c", { status: "Cancelled" }), t("d", { status: "Completed" }), t("e", { status: null })], NO_FILTERS, "none", "manual", ctx);
    expect(m.statuses).toEqual(["Open", "Working", "Pending Review", "Completed"]);
    expect(keys(m, "Open")).toEqual(["a", "e"]);
    expect([m.shown, m.total]).toEqual([4, 4]);
    expect(boardModel([t("x", { status: "Overdue" })], NO_FILTERS, "none", "manual", ctx).statuses).toContain("Overdue");
  });

  it("keeps the columns while a filter hides every card", () => {
    const m = boardModel([t("a")], { ...NO_FILTERS, q: "zzz" }, "none", "manual", ctx);
    expect(m.statuses).toHaveLength(4);
    expect([m.shown, m.total]).toEqual([0, 1]);
  });

  it("orders a column by rank, by due date or by priority", () => {
    const tasks = [
      t("a", { rank: 3000, exp_end_date: "2026-11-20", priority: "Low" }),
      t("b", { rank: 1000, exp_end_date: "2026-11-30", priority: "Urgent" }),
      t("c", { rank: 2000, priority: "High" }),
      t("d", { exp_end_date: "2026-11-12" }),
    ];
    expect(keys(boardModel(tasks, NO_FILTERS, "none", "manual", ctx), "Open")).toEqual(["b", "c", "a", "d"]);
    expect(keys(boardModel(tasks, NO_FILTERS, "none", "due", ctx), "Open")).toEqual(["d", "a", "b", "c"]);
    expect(keys(boardModel(tasks, NO_FILTERS, "none", "priority", ctx), "Open")).toEqual(["b", "c", "d", "a"]);
  });
});

describe("filters", () => {
  const tasks = [
    t("mine", { assigned_to: who("Asha@Acme.test"), priority: "High", exp_end_date: "2026-11-05" }),
    t("theirs", { assigned_to: who("ravi@acme.test"), exp_end_date: "2026-11-14" }),
    t("nobody", { priority: "Low" }),
    t("sub", { parent_task: "mine", subject: "Write the Spec", exp_end_date: "2026-11-30" }),
  ];
  const ids = (f: Partial<Filters>) => tasks.filter((x) => matches(x, { ...NO_FILTERS, ...f }, ctx.me, today)).map((x) => x.id);

  it("finds a task by what a card shows", () => {
    expect(ids({ q: "spec" })).toEqual(["sub"]);
    expect(ids({ q: " MINE " })).toEqual(["mine"]);
  });

  it("filters by person, priority and due date", () => {
    expect(ids({ who: "me" })).toEqual(["mine"]);
    expect(ids({ who: "none" })).toEqual(["nobody", "sub"]);
    expect(ids({ who: "RAVI@acme.test" })).toEqual(["theirs"]);
    expect(ids({ priority: "High" })).toEqual(["mine"]);
    expect(ids({ priority: "Medium" })).toEqual(["theirs", "sub"]);
    expect(ids({ due: "late" })).toEqual(["mine"]);
    expect(ids({ due: "week" })).toEqual(["theirs"]);
    expect(ids({ due: "none" })).toEqual(["nobody"]);
  });

  it("filters by parent", () => {
    expect(ids({ parent: "top" })).toEqual(["mine", "theirs", "nobody"]);
    expect(ids({ parent: "mine" })).toEqual(["sub"]);
  });

  it("lives in the address and survives the trip", () => {
    const f: Filters = { q: "spec", who: "me", priority: "High", due: "late", parent: "top" };
    const sp = new URLSearchParams(Object.entries(filterParams(f)).filter((e): e is [string, string] => e[1] !== null));
    expect(readFilters(sp)).toEqual(f);
    expect(filterParams(NO_FILTERS)).toEqual({ q: null, who: null, prio: null, due: null, parent: null });
    expect(readFilters(new URLSearchParams("prio=Huge&due=never"))).toEqual(NO_FILTERS);
    expect([readLanes(new URLSearchParams("lanes=priority")), readLanes(new URLSearchParams("lanes=x")), readOrder(new URLSearchParams("order=due")), readOrder(new URLSearchParams())]).toEqual(["priority", "none", "due", "manual"]);
  });
});

describe("swimlanes", () => {
  const tasks = [
    t("a", { assigned_to: who("ravi@acme.test"), priority: "High" }),
    t("b", { assigned_to: who("asha@acme.test", "ravi@acme.test"), status: "Working" }),
    t("c", { priority: "Urgent" }),
  ];

  it("has a lane for each person, a task with two people showing in both, and a lane for nobody", () => {
    const m = boardModel(tasks, NO_FILTERS, "assignee", "manual", ctx);
    expect(m.lanes.map((l) => [l.id, l.count])).toEqual([
      ["asha@acme.test", 1],
      ["ravi@acme.test", 2],
      [NOBODY, 1],
    ]);
    expect(keys(m, "Working", "ravi@acme.test")).toEqual(["b"]);
    expect(keys(m, "Working", "asha@acme.test")).toEqual(["b"]);
    // each card has its own key, so two lanes can show one task
    const all = m.lanes.flatMap((l) => l.cells.flatMap((c) => c.cards.map((x) => x.key)));
    expect(new Set(all).size).toBe(all.length);
  });

  it("has a lane for each priority in use, most pressing first", () => {
    const m = boardModel(tasks, NO_FILTERS, "priority", "manual", ctx);
    expect(m.lanes.map((l) => l.id)).toEqual(["Urgent", "High", "Medium"]);
  });

  it("falls back to one lane when there is nothing to group", () => {
    expect(boardModel([], NO_FILTERS, "assignee", "manual", ctx).lanes.map((l) => l.id)).toEqual([""]);
  });
});

describe("a drop", () => {
  const tasks = [t("a", { rank: 1000 }), t("b", { rank: 2000 }), t("c", { rank: 3000 }), t("w", { status: "Working", rank: 1000 }), t("w2", { status: "Working", rank: 2000 })];
  const m = boardModel(tasks, NO_FILTERS, "none", "manual", ctx);

  it("changes nothing when the card is put back", () => {
    expect(dropPlan(m, "|b", "|Open", 1, "none", "manual")).toBeNull();
  });

  it("reorders within a column by writing one rank", () => {
    expect(dropPlan(m, "|c", "|Open", 0, "none", "manual")).toEqual({ patch: { rank: "0.000000" }, also: [] });
    expect(dropPlan(m, "|a", "|Open", 1, "none", "manual")).toEqual({ patch: { rank: "2500.000000" }, also: [] });
  });

  it("moves between columns and ranks the card among the cards it lands between", () => {
    expect(dropPlan(m, "|a", "|Working", 1, "none", "manual")).toEqual({ patch: { status: "Working", rank: "1500.000000" }, also: [] });
    expect(dropPlan(m, "|a", "|Working", 2, "none", "manual")).toEqual({ patch: { status: "Working", rank: "3000.000000" }, also: [] });
  });

  it("moves to a column's foot when it is empty", () => {
    expect(dropPlan(m, "|a", "|Completed", 0, "none", "manual")).toEqual({ patch: { status: "Completed", rank: "1000.000000" }, also: [] });
  });

  it("under another sort moves between columns only", () => {
    const due = boardModel(tasks, NO_FILTERS, "none", "due", ctx);
    expect(dropPlan(due, "|a", "|Working", 1, "none", "due")).toEqual({ patch: { status: "Working" }, also: [] });
    expect(dropPlan(due, "|a", "|Open", 2, "none", "due")).toBeNull();
  });

  it("refuses Overdue, which follows the dates", () => {
    const withOverdue = boardModel([...tasks, t("o", { status: "Overdue" })], NO_FILTERS, "none", "manual", ctx);
    expect(dropPlan(withOverdue, "|a", "|Overdue", 0, "none", "manual")).toBeNull();
  });

  it("changes the priority when dropped in another priority's lane, and keeps a person's lane", () => {
    const lanes = boardModel([t("a", { priority: "High" }), t("b", { priority: "Low" })], NO_FILTERS, "priority", "manual", ctx);
    expect(dropPlan(lanes, "High|a", "Low|Working", 1, "priority", "manual")).toEqual({ patch: { status: "Working", priority: "Low", rank: "1000.000000" }, also: [] });
    expect(dropPlan(lanes, "High|a", "Low|Open", 1, "priority", "manual")?.patch).toMatchObject({ priority: "Low" });
    const people = boardModel([t("a", { assigned_to: who("ravi@acme.test") }), t("b", { assigned_to: who("asha@acme.test") })], NO_FILTERS, "assignee", "manual", ctx);
    expect(dropPlan(people, "ravi@acme.test|a", "asha@acme.test|Working", 0, "assignee", "manual")).toBeNull();
    expect(dropPlan(people, "ravi@acme.test|a", "ravi@acme.test|Working", 0, "assignee", "manual")?.patch.status).toBe("Working");
  });

  it("knows where a drop may land", () => {
    const people = boardModel([t("a", { assigned_to: who("ravi@acme.test") }), t("b", { assigned_to: who("asha@acme.test") })], NO_FILTERS, "assignee", "manual", ctx);
    const [asha, ravi] = people.lanes;
    expect(dropAllowed("assignee", asha.cells[0], ravi.cells[1])).toBe(false);
    expect(dropAllowed("assignee", asha.cells[0], asha.cells[1])).toBe(true);
    expect(dropAllowed("priority", asha.cells[0], ravi.cells[1])).toBe(true);
  });
});

describe("the keyboard", () => {
  const tasks = [t("a", { rank: 1 }), t("b", { rank: 2 }), t("c", { rank: 3 }), t("w", { status: "Working", rank: 1 }), t("o", { status: "Overdue", rank: 1 })];
  const m = boardModel(tasks, NO_FILTERS, "none", "manual", ctx);

  it("moves a card one place up or down its column", () => {
    expect(keyMove(m, "|b", "up", "manual")).toEqual({ to: "|Open", at: 0 });
    expect(keyMove(m, "|b", "down", "manual")).toEqual({ to: "|Open", at: 2 });
    expect(keyMove(m, "|a", "up", "manual")).toBeNull();
    expect(keyMove(m, "|c", "down", "manual")).toBeNull();
    expect(keyMove(m, "|b", "up", "due")).toBeNull();
  });

  it("moves a card one column over, to the same height or the foot, and never onto Overdue", () => {
    expect(keyMove(m, "|c", "right", "manual")).toEqual({ to: "|Working", at: 1 });
    expect(keyMove(m, "|a", "right", "manual")).toEqual({ to: "|Working", at: 0 });
    expect(keyMove(m, "|w", "left", "manual")).toEqual({ to: "|Open", at: 0 });
    expect(keyMove(m, "|a", "left", "manual")).toBeNull();
    expect(keyMove(m, "|nothing", "left", "manual")).toBeNull();
  });

  it("walks focus through the cards", () => {
    expect(focusMove(m, "|a", "down")).toBe("|b");
    expect(focusMove(m, "|c", "down")).toBeNull();
    // focus may rest on an Overdue card, though a card cannot be put there
    expect(focusMove(m, "|c", "right")).toBe("|o");
    expect(focusMove(m, "|o", "right")).toBe("|w");
    expect(focusMove(m, "|w", "right")).toBeNull();
    expect(focusMove(m, "|a", "next")).toBe("|b");
    expect(focusMove(m, "|a", "previous")).toBeNull();
    expect(findCard(m, "|w")?.cell.status).toBe("Working");
  });
});

describe("what a card shows", () => {
  it("knows a late task and who works on it", () => {
    expect(late(t("a", { exp_end_date: "2026-10-30" }), "2026-11-01")).toBe(true);
    expect(late(t("b", { exp_end_date: "2026-10-30", status: "Completed" }), "2026-11-01")).toBe(false);
    expect(late(t("c", { exp_end_date: "2026-11-01" }), "2026-11-01")).toBe(false);
    expect(assignees(t("d", { assigned_to: [{ user: "a@x.test" }, { user: null }] }))).toEqual(["a@x.test"]);
  });

  it("counts sub-tasks done of all, leaving out the cancelled", () => {
    const c = subtaskCounts([t("p"), t("1", { parent_task: "p", status: "Completed" }), t("2", { parent_task: "p" }), t("3", { parent_task: "p", status: "Cancelled" })]);
    expect(c.get("p")).toEqual({ done: 1, total: 2 });
    expect(c.get("1")).toBeUndefined();
  });

  it("knows what keeps a task from starting: predecessors not completed", () => {
    const tasks = [t("a", { status: "Completed" }), t("b", { status: "Working" }), t("c", { depends_on: [{ task: "a" }, { task: "b" }, { task: "gone" }] })];
    const byId = new Map(tasks.map((x) => [x.id, x]));
    expect(blockers(tasks[2], byId).map((x) => x.id)).toEqual(["b"]);
    expect(blockers(tasks[0], byId)).toEqual([]);
  });

  it("makes a mark from an address", () => {
    expect([mark("asha.rao@acme.test"), mark("admin@demo.test"), mark(null)]).toEqual(["AR", "AD", "?"]);
  });
});
