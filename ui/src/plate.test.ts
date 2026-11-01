import { describe, expect, it } from "vitest";
import type { Task } from "./plan";
import { byHorizon, byProject, horizon, plate } from "./plate";

const today = "2026-11-10";
const t = (id: string, extra: Partial<Task> = {}): Task => ({ id, number: id, status: "Open", ...extra });

describe("what is on a plate", () => {
  it("says when a task falls due", () => {
    expect([null, "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-17", "2026-11-18"].map((d) => horizon(d, today))).toEqual(["No date", "Overdue", "Today", "Next 7 days", "Next 7 days", "Later"]);
  });

  it("groups open tasks by when they fall due, the soonest and most pressing first, leaving empty groups out", () => {
    const tasks = [
      t("late-low", { exp_end_date: "2026-11-01", priority: "Low" }),
      t("late-urgent", { exp_end_date: "2026-11-01", priority: "Urgent" }),
      t("earlier", { exp_end_date: "2026-10-20" }),
      t("now", { exp_end_date: today }),
      t("someday"),
      t("done", { exp_end_date: today, status: "Completed" }),
      t("dropped", { status: "Cancelled" }),
    ];
    const groups = byHorizon(tasks, today);
    expect(groups.map((g) => g.label)).toEqual(["Overdue", "Today", "No date"]);
    expect(groups[0].tasks.map((x) => x.id)).toEqual(["earlier", "late-urgent", "late-low"]);
  });

  it("groups by project, the project with the soonest work first", () => {
    const tasks = [
      t("a", { project: "p2", exp_end_date: "2026-11-20", _titles: { project: "Website" } }),
      t("b", { project: "p1", exp_end_date: "2026-11-12", _titles: { project: "App" } }),
      t("c", { project: "p2", exp_end_date: "2026-11-11", _titles: { project: "Website" } }),
      t("d", { project: null }),
    ];
    const groups = byProject(tasks, (x) => x._titles?.project ?? "");
    expect(groups.map((g) => [g.label, g.tasks.map((x) => x.id)])).toEqual([
      ["Website", ["c", "a"]],
      ["App", ["b"]],
      ["No project", ["d"]],
    ]);
  });

  it("adds a plate up: how many, how many late, how many today, how many hours to go", () => {
    const tasks = [
      t("a", { exp_end_date: "2026-11-01", expected_hours: "8", actual_hours: "3" }),
      t("b", { exp_end_date: today, expected_hours: 4 }),
      t("c", { expected_hours: "2", actual_hours: "5" }),
      t("d", { status: "Completed", expected_hours: 100 }),
    ];
    expect(plate(tasks, today)).toEqual({ open: 3, late: 1, today: 1, hours: 9 });
    expect(plate([], today)).toEqual({ open: 0, late: 0, today: 0, hours: 0 });
  });
});
