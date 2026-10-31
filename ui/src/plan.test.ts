import { describe, expect, it } from "vitest";
import { assignees, board, late, timeline, type Task } from "./plan";

const t = (id: string, extra: Partial<Task> = {}): Task => ({ id, status: "Open", ...extra });

describe("the project view", () => {
  it("puts tasks in the board's columns, Overdue only when used, Cancelled never", () => {
    const cols = board([t("a"), t("b", { status: "Working" }), t("c", { status: "Cancelled" }), t("d", { status: "Completed" }), t("e", { status: null })]);
    expect(cols.map((c) => [c.status, c.tasks.map((x) => x.id)])).toEqual([
      ["Open", ["a", "e"]],
      ["Working", ["b"]],
      ["Pending Review", []],
      ["Completed", ["d"]],
    ]);
    expect(board([t("x", { status: "Overdue" })]).map((c) => c.status)).toContain("Overdue");
  });

  it("knows a late task and who works on it", () => {
    expect(late(t("a", { exp_end_date: "2026-10-30" }), "2026-11-01")).toBe(true);
    expect(late(t("b", { exp_end_date: "2026-10-30", status: "Completed" }), "2026-11-01")).toBe(false);
    expect(late(t("c", { exp_end_date: "2026-11-01" }), "2026-11-01")).toBe(false);
    expect(assignees(t("d", { assigned_to: [{ user: "a@x.test" }, { user: null }] }))).toEqual(["a@x.test"]);
  });

  it("places bars over the tasks' span and the project's dates", () => {
    const tl = timeline(
      [
        t("design", { exp_start_date: "2026-11-01", exp_end_date: "2026-11-10" }),
        t("build", { exp_start_date: "2026-11-11", exp_end_date: "2026-11-30" }),
        t("launch", { exp_end_date: "2026-11-30", exp_start_date: "2026-11-20", is_milestone: true }),
        t("someday"),
      ],
      "2026-11-01",
      "2026-11-30",
    );
    expect([tl.start, tl.end, tl.days]).toEqual(["2026-11-01", "2026-11-30", 30]);
    expect(tl.bars.map((b) => [b.task.id, Math.round(b.left * 30), Math.round(b.width * 30)])).toEqual([
      ["design", 0, 10],
      ["build", 10, 20],
      ["launch", 29, 1],
    ]);
    expect(tl.unscheduled.map((x) => x.id)).toEqual(["someday"]);
    expect(tl.months.map((m) => m.left)).toEqual([0]);
    // A span starting mid-month labels that month from its start.
    const mid = timeline([t("x", { exp_start_date: "2026-10-20", exp_end_date: "2026-11-09" })]);
    expect(mid.months.map((m) => Math.round(m.left * mid.days))).toEqual([0, 12]);
    expect(timeline([t("only")]).days).toBe(0);
  });
});
