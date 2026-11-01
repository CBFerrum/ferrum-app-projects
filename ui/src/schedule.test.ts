import { describe, expect, it } from "vitest";
import { addDays, dayNumber, diffDays, weekdaysIn, weekStart } from "./days";
import type { Task } from "./plan";
import { arrow, cascade, critical, dayAt, dayUnder, dragged, firstDates, header, length, links, outline, PX, spanOf, viewOf, weekends, writes } from "./schedule";

const t = (id: string, start: string | null, end: string | null, extra: Partial<Task> = {}): Task => ({ id, number: id, status: "Open", exp_start_date: start, exp_end_date: end, ...extra });
const after = (...ids: string[]) => ids.map((task) => ({ task }));
const spans = (changes: ReturnType<typeof cascade>["changes"]) => Object.fromEntries(changes.map((c) => [c.id, [c.after.start, c.after.end, c.kind]]));

describe("days", () => {
  it("counts calendar days and weeks without time zones", () => {
    expect(diffDays("2026-11-01", "2026-11-10")).toBe(9);
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(weekStart("2026-11-01")).toBe("2026-10-26");
    expect(weekStart("2026-11-02")).toBe("2026-11-02");
    expect(dayNumber("1970-01-02")).toBe(1);
  });

  it("counts weekdays", () => {
    // Monday 2 to Sunday 8 November
    expect(weekdaysIn("2026-11-02", "2026-11-08")).toBe(5);
    expect(weekdaysIn("2026-11-07", "2026-11-08")).toBe(0);
    expect(weekdaysIn("2026-11-06", "2026-11-09")).toBe(2);
    expect(weekdaysIn("2026-11-02", "2026-11-02")).toBe(1);
  });
});

describe("a task's days", () => {
  it("takes one date as a day, a milestone as a point on its end, and no dates as none", () => {
    expect(spanOf(t("a", "2026-11-02", "2026-11-05"))).toEqual({ start: "2026-11-02", end: "2026-11-05" });
    expect(spanOf(t("b", null, "2026-11-05"))).toEqual({ start: "2026-11-05", end: "2026-11-05" });
    expect(spanOf(t("c", "2026-11-05", null))).toEqual({ start: "2026-11-05", end: "2026-11-05" });
    expect(spanOf(t("d", "2026-11-01", "2026-11-09", { is_milestone: true }))).toEqual({ start: "2026-11-09", end: "2026-11-09" });
    expect(spanOf(t("e", null, null))).toBeNull();
    expect(spanOf(t("f", "2026-11-09", "2026-11-01"))).toEqual({ start: "2026-11-01", end: "2026-11-01" });
  });
});

describe("the view", () => {
  const today = "2026-11-10";

  it("takes in every task and today with room around, in whole weeks", () => {
    const v = viewOf([{ start: "2026-11-04", end: "2026-11-20" }], today, "week");
    expect(v.from).toBe("2026-10-26");
    expect(v.to >= "2026-12-11").toBe(true);
    expect(v.px).toBe(PX.week);
    expect(v.days).toBe(diffDays(v.from, v.to) + 1);
    expect(v.days % 7).toBe(0);
  });

  it("rounds out to whole months at the coarser zooms", () => {
    const m = viewOf([{ start: "2026-11-04", end: "2026-11-20" }], today, "month");
    expect([m.from, m.to]).toEqual(["2026-10-01", "2026-12-31"]);
    const q = viewOf([{ start: "2026-11-04", end: "2026-11-20" }], today, "quarter");
    expect([q.from, q.to]).toEqual(["2026-10-01", "2026-12-31"]);
  });

  it("is never narrower than six weeks", () => {
    const v = viewOf([], today, "day");
    expect(v.days).toBeGreaterThanOrEqual(42);
  });

  it("labels months over days, and years over months", () => {
    const v = viewOf([{ start: "2026-11-04", end: "2026-11-20" }], today, "day");
    const h = header(v);
    expect(h.bottom.length).toBe(v.days);
    expect(h.bottom[0]).toMatchObject({ label: "26", at: 0, span: 1 });
    expect(h.top.reduce((n, x) => n + x.span, 0)).toBe(v.days);
    expect(h.top[0].span).toBe(6); // 26 to 31 October
    const m = header(viewOf([{ start: "2026-11-04", end: "2026-11-20" }], today, "month"));
    expect(m.top.map((x) => x.label)).toEqual(["2026"]);
    expect(m.bottom).toHaveLength(3);
    expect(m.bottom.reduce((n, x) => n + x.span, 0)).toBe(92);
    const q = header(viewOf([{ start: "2026-11-04", end: "2026-11-20" }], today, "quarter"));
    expect(q.bottom.map((x) => x.label)).toEqual(["Q4"]);
  });

  it("shades weekends only where a day is wide enough to see", () => {
    const v = viewOf([{ start: "2026-11-04", end: "2026-11-20" }], today, "week");
    const w = weekends(v);
    expect(w[0]).toEqual({ at: 5, span: 2 }); // 31 Oct and 1 Nov, after Monday the 26th
    expect(weekends(viewOf([], today, "month"))).toEqual([]);
  });

  it("maps days to places and back", () => {
    const v = viewOf([{ start: "2026-11-04", end: "2026-11-20" }], today, "day");
    expect(dayAt(v, "2026-10-28")).toBe(2);
    expect(dayUnder(v, 2 * v.px + 5)).toBe("2026-10-28");
    expect(firstDates("2026-11-10", "week")).toEqual({ start: "2026-11-10", end: "2026-11-11" });
    expect(firstDates("2026-11-10", "quarter")).toEqual({ start: "2026-11-10", end: "2026-11-16" });
  });
});

describe("the rows", () => {
  const tasks = [
    t("late", "2026-11-20", "2026-11-25", { number: "T3" }),
    t("parent", null, null, { number: "T1" }),
    t("kid1", "2026-11-02", "2026-11-05", { parent_task: "parent", number: "T4" }),
    t("kid2", "2026-11-04", "2026-11-12", { parent_task: "parent", number: "T5" }),
    t("kid3", null, null, { parent_task: "parent", number: "T6" }),
    t("solo", "2026-11-01", "2026-11-03", { number: "T2" }),
    t("someday", null, null, { number: "T7" }),
    t("gone", "2026-11-01", "2026-11-03", { status: "Cancelled" }),
  ];

  it("lists a tree by first day, a parent without days drawn from its sub-tasks", () => {
    const o = outline(tasks, new Set());
    expect(o.rows.map((r) => [r.task.id, r.depth])).toEqual([
      ["solo", 0],
      ["parent", 0],
      ["kid1", 1],
      ["kid2", 1],
      ["kid3", 1],
      ["late", 0],
    ]);
    const parent = o.rows[1];
    expect([parent.span, parent.summary, parent.kids]).toEqual([{ start: "2026-11-02", end: "2026-11-12" }, true, 3]);
    expect(o.rows[4].span).toBeNull();
    expect(o.unscheduled.map((x) => x.id)).toEqual(["someday"]);
  });

  it("hides the sub-tasks of a folded parent", () => {
    expect(outline(tasks, new Set(["parent"])).rows.map((r) => r.task.id)).toEqual(["solo", "parent", "late"]);
  });

  it("draws a link from one bar to the next, broken when the second starts too soon", () => {
    const rows = outline([t("a", "2026-11-02", "2026-11-05"), t("b", "2026-11-06", "2026-11-08", { depends_on: [{ task: "a" }] }), t("c", "2026-11-05", "2026-11-08", { depends_on: [{ task: "a" }, { task: "gone" }] })], new Set()).rows;
    // rows come in order of their first day, so c is before b
    expect(links(rows)).toEqual([
      { from: "a", to: "c", ok: false },
      { from: "a", to: "b", ok: true },
    ]);
  });

  it("draws an arrow with elbows, round the back when the link is broken", () => {
    expect(arrow(100, 18, 140, 54)).toBe("M100,18 H108 V54 H140");
    expect(arrow(100, 18, 104, 54)).toBe("M100,18 H108 V36 H96 V54 H104");
    expect(arrow(100, 54, 104, 18)).toBe("M100,54 H108 V36 H96 V18 H104");
  });
});

describe("dragging a bar", () => {
  const task = t("a", "2026-11-02", "2026-11-05");

  it("moves the whole bar, or one end of it, which never passes the other", () => {
    expect(dragged(task, "move", 3)).toEqual({ id: "a", start: "2026-11-05", end: "2026-11-08" });
    expect(dragged(task, "move", -2)).toEqual({ id: "a", start: "2026-10-31", end: "2026-11-03" });
    expect(dragged(task, "end", 2)).toEqual({ id: "a", start: "2026-11-02", end: "2026-11-07" });
    expect(dragged(task, "end", -9)).toEqual({ id: "a", start: "2026-11-02", end: "2026-11-02" });
    expect(dragged(task, "start", -1)).toEqual({ id: "a", start: "2026-11-01", end: "2026-11-05" });
    expect(dragged(task, "start", 9)).toEqual({ id: "a", start: "2026-11-05", end: "2026-11-05" });
  });

  it("moves a milestone and nothing else, and has nothing to drag when it has no days", () => {
    expect(dragged(t("m", "2026-11-01", "2026-11-05", { is_milestone: true }), "end", 2)).toEqual({ id: "m", start: "2026-11-07", end: "2026-11-07" });
    expect(dragged(t("n", null, null), "move", 1)).toBeNull();
  });
});

describe("what moving a task moves", () => {
  // design (2-6) -> build (7-14) -> launch (15-16); docs (3-5) is alone; plan has no days and waits for design
  const tasks = [
    t("design", "2026-11-02", "2026-11-06"),
    t("build", "2026-11-07", "2026-11-14", { depends_on: [{ task: "design" }] }),
    t("launch", "2026-11-15", "2026-11-16", { depends_on: [{ task: "build" }] }),
    t("docs", "2026-11-03", "2026-11-05"),
    t("plan", null, null, { depends_on: [{ task: "design" }] }),
  ];

  it("moves only the task dragged when nothing waits for it", () => {
    const p = cascade(tasks, [{ id: "docs", start: "2026-11-10", end: "2026-11-12" }]);
    expect(spans(p.changes)).toEqual({ docs: ["2026-11-10", "2026-11-12", "dragged"] });
    expect(p.skipped).toEqual([]);
  });

  it("leaves what waits alone while the link still holds", () => {
    const p = cascade(tasks, [{ id: "design", start: "2026-11-02", end: "2026-11-06" }]);
    expect(p.changes).toEqual([]);
    const sooner = cascade(tasks, [{ id: "design", start: "2026-10-26", end: "2026-10-30" }]);
    expect(Object.keys(spans(sooner.changes))).toEqual(["design"]);
  });

  it("pushes what waits later by as little as keeps the link, keeping its length, down the chain", () => {
    // design now ends on the 9th: build must start on the 10th (3 days later), and launch follows build's new end
    const p = cascade(tasks, [{ id: "design", start: "2026-11-05", end: "2026-11-09" }]);
    expect(spans(p.changes)).toEqual({
      design: ["2026-11-05", "2026-11-09", "dragged"],
      build: ["2026-11-10", "2026-11-17", "pushed"],
      launch: ["2026-11-18", "2026-11-19", "pushed"],
    });
    expect(p.skipped).toEqual(["plan"]);
    expect(p.changes[1].before).toEqual({ start: "2026-11-07", end: "2026-11-14" });
  });

  it("spares a task its slack: a gap before the link absorbs the move", () => {
    const slack = [t("a", "2026-11-02", "2026-11-04"), t("b", "2026-11-10", "2026-11-12", { depends_on: [{ task: "a" }] })];
    expect(spans(cascade(slack, [{ id: "a", start: "2026-11-06", end: "2026-11-08" }]).changes)).toEqual({ a: ["2026-11-06", "2026-11-08", "dragged"] });
    expect(spans(cascade(slack, [{ id: "a", start: "2026-11-09", end: "2026-11-11" }]).changes)).toEqual({
      a: ["2026-11-09", "2026-11-11", "dragged"],
      b: ["2026-11-12", "2026-11-14", "pushed"],
    });
  });

  it("pulls the task before earlier when one dragged to start sooner than its link allows", () => {
    // build dragged to start on the 4th: design (2-6) must now end on the 3rd, a pull of 3 days
    const p = cascade(tasks, [{ id: "build", start: "2026-11-04", end: "2026-11-11" }]);
    expect(spans(p.changes)).toEqual({
      build: ["2026-11-04", "2026-11-11", "dragged"],
      design: ["2026-10-30", "2026-11-03", "pulled"],
      // launch (15-16) still starts after build ends, so it stays
    });
  });

  it("takes the dated sub-tasks along with a parent moved whole", () => {
    const tree = [t("p", "2026-11-02", "2026-11-12"), t("k1", "2026-11-02", "2026-11-05", { parent_task: "p" }), t("k2", null, null, { parent_task: "p" }), t("k3", "2026-11-06", "2026-11-12", { parent_task: "k1" })];
    const p = cascade(tree, [{ id: "p", start: "2026-11-04", end: "2026-11-14" }]);
    expect(spans(p.changes)).toEqual({ p: ["2026-11-04", "2026-11-14", "dragged"], k1: ["2026-11-04", "2026-11-07", "child"], k3: ["2026-11-08", "2026-11-14", "child"] });
    // resizing a parent does not move its sub-tasks
    expect(Object.keys(spans(cascade(tree, [{ id: "p", start: "2026-11-02", end: "2026-11-14" }]).changes))).toEqual(["p"]);
  });

  it("lets the dragged tasks stand even where they break a link between themselves", () => {
    const p = cascade(tasks, [
      { id: "design", start: "2026-11-10", end: "2026-11-12" },
      { id: "build", start: "2026-11-07", end: "2026-11-14" },
    ]);
    expect(spans(p.changes).build).toBeUndefined(); // unchanged, and not moved by design
    expect(spans(p.changes).design).toEqual(["2026-11-10", "2026-11-12", "dragged"]);
  });

  it("gives days to a task that had none", () => {
    const p = cascade(tasks, [{ id: "plan", start: "2026-11-07", end: "2026-11-08" }]);
    expect(p.changes).toEqual([{ id: "plan", kind: "dragged", before: null, after: { start: "2026-11-07", end: "2026-11-08" } }]);
  });

  it("does not hang on links that go round in a circle", () => {
    const loop = [t("x", "2026-11-02", "2026-11-04", { depends_on: [{ task: "y" }] }), t("y", "2026-11-05", "2026-11-07", { depends_on: [{ task: "x" }] })];
    expect(() => cascade(loop, [{ id: "x", start: "2026-11-10", end: "2026-11-12" }])).not.toThrow();
  });

  it("names the dates to write: dragged ones as they stand, the rest moved by the days they moved", () => {
    const p = cascade(tasks, [{ id: "design", start: "2026-11-05", end: "2026-11-09" }]);
    const by = Object.fromEntries(p.changes.map((c) => [c.id, writes(tasks.find((x) => x.id === c.id) as Task, c)]));
    expect(by.design).toEqual({ exp_start_date: "2026-11-05", exp_end_date: "2026-11-09" });
    expect(by.build).toEqual({ exp_start_date: "2026-11-10", exp_end_date: "2026-11-17" });
    // a task with one date keeps to that one
    const one = t("one", null, "2026-11-05", { depends_on: [{ task: "design" }] });
    const q = cascade([tasks[0], one], [{ id: "design", start: "2026-11-05", end: "2026-11-09" }]);
    expect(writes(one, q.changes[1])).toEqual({ exp_start_date: null, exp_end_date: "2026-11-10" });
    // a milestone dragged keeps the distance between its dates
    const m = t("m", "2026-11-01", "2026-11-05", { is_milestone: true });
    const r = cascade([m], [{ id: "m", start: "2026-11-07", end: "2026-11-07" }]);
    expect(writes(m, r.changes[0])).toEqual({ exp_start_date: "2026-11-03", exp_end_date: "2026-11-07" });
  });
});

describe("the critical path", () => {
  it("marks linked tasks with no room, working back from the project's last day", () => {
    const tasks = [
      t("a", "2026-11-02", "2026-11-06"),
      t("b", "2026-11-07", "2026-11-10", { depends_on: [{ task: "a" }] }),
      t("c", "2026-11-11", "2026-11-14", { depends_on: [{ task: "b" }] }),
      t("side", "2026-11-02", "2026-11-04"),
      t("short", "2026-11-07", "2026-11-08", { depends_on: [{ task: "a" }] }),
      t("end", "2026-11-12", "2026-11-14", { depends_on: [{ task: "short" }] }),
    ];
    // a-b-c is tight to the 14th; short and end have room (end is planned for the 12th but could follow short on the 9th); side is alone
    expect([...critical(tasks)].sort()).toEqual(["a", "b", "c"]);
  });

  it("is empty when nothing is linked or dated", () => {
    expect(critical([t("a", "2026-11-02", "2026-11-04"), t("b", null, null)]).size).toBe(0);
    expect(critical([]).size).toBe(0);
  });

  it("is not thrown by a cycle", () => {
    const loop = [t("x", "2026-11-02", "2026-11-04", { depends_on: [{ task: "y" }] }), t("y", "2026-11-05", "2026-11-07", { depends_on: [{ task: "x" }] })];
    expect(() => critical(loop)).not.toThrow();
  });
});

void after;

describe("what moving a task moves, over many schedules", () => {
  // A small deterministic generator, so a failure can be run again.
  const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

  it("always leaves every link whole, lengths as they were, and tasks without links alone", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rand = rng(seed);
      const pick = (n: number) => Math.floor(rand() * n);
      const n = 3 + pick(9);
      // Links only run from an earlier task to a later one, so there is no cycle; each task starts after what it waits for.
      const tasks: Task[] = [];
      for (let i = 0; i < n; i++) {
        const preds = Array.from({ length: i }, (_, p) => p).filter(() => rand() < 0.3);
        const earliest = Math.max(0, ...preds.map((p) => diffDays("2026-11-01", tasks[p].exp_end_date as string) + 1));
        const start = earliest + pick(4);
        const end = start + pick(5);
        tasks.push(t(`t${i}`, addDays("2026-11-01", start), addDays("2026-11-01", end), { depends_on: preds.map((p) => ({ task: `t${p}` })) }));
      }
      const dragTask = tasks[pick(n)];
      const mode = (["move", "start", "end"] as const)[pick(3)];
      const edit = dragged(dragTask, mode, pick(21) - 10);
      if (!edit) continue;
      const plan = cascade(tasks, [edit]);

      const after = new Map(tasks.map((x) => [x.id, spanOf(x) as { start: string; end: string }]));
      for (const c of plan.changes) after.set(c.id, c.after);
      for (const x of tasks) {
        for (const p of x.depends_on ?? []) {
          const [a, b] = [after.get(p.task as string) as { end: string }, after.get(x.id) as { start: string }];
          expect(b.start > a.end, `seed ${seed}: ${p.task} → ${x.id} after dragging ${dragTask.id} (${mode})`).toBe(true);
        }
      }
      for (const c of plan.changes.filter((x) => x.kind !== "dragged")) {
        expect(length(c.after), `seed ${seed}: ${c.id} keeps its length`).toBe(length(c.before as { start: string; end: string }));
      }
      expect(plan.changes.filter((c) => c.kind === "dragged").map((c) => c.id).every((id) => id === dragTask.id)).toBe(true);
    }
  });
});
