import { describe, expect, it } from "vitest";
import { backlogModel, placeAt, type Sprint } from "./sprints";
import type { Task } from "./plan";

const sprint = (id: string, state: Sprint["state"], start: string): Sprint => ({ id, sprint_name: `Sprint ${id}`, start_date: start, end_date: start, state });
const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, number: `T-${id}`, subject: `Task ${id}`, status: "Open", ...extra });

describe("the backlog's sections", () => {
  it("sections come in order: active, planned by start, backlog", () => {
    const m = backlogModel([task("1")], [sprint("b", "Planned", "2026-12-14"), sprint("a", "Planned", "2026-11-30"), sprint("x", "Active", "2026-11-16")]);
    expect(m.sections.map((s) => s.sprint?.id ?? null)).toEqual(["x", "a", "b", null]);
  });

  it("a cancelled task is in no section; a completed task is not in the backlog; a task of a closed sprint is left out", () => {
    const tasks = [
      task("1", { sprint: "x", status: "Cancelled" }),
      task("2", { sprint: "x", status: "Completed" }),
      task("3", { status: "Completed" }),
      task("4", { sprint: "closed" }),
      task("5"),
    ];
    const m = backlogModel(tasks, [sprint("x", "Active", "2026-11-16")]);
    expect(m.sections[0].tasks.map((t) => t.id)).toEqual(["2"]);
    expect(m.sections[1].tasks.map((t) => t.id)).toEqual(["5"]);
  });

  it("points and open counts add up", () => {
    const m = backlogModel([task("1", { sprint: "x", story_points: "3" }), task("2", { sprint: "x", story_points: 5, status: "Completed" }), task("3", { sprint: "x" })], [sprint("x", "Active", "2026-11-16")]);
    expect([m.sections[0].points, m.sections[0].open]).toEqual([8, 2]);
  });

  it("orders the backlog by its own rank, the unranked last by number", () => {
    const m = backlogModel([task("1"), task("2", { backlog_rank: "2000" }), task("3", { backlog_rank: "1000" })], []);
    expect(m.sections[0].tasks.map((t) => t.id)).toEqual(["3", "2", "1"]);
  });
});

describe("moving in the backlog", () => {
  const tasks = [task("1", { backlog_rank: "1000" }), task("2", { backlog_rank: "2000" }), task("3")];

  it("puts a task at the top, one up and one down, and ranks unranked neighbours first", () => {
    expect(placeAt(tasks, "2", "top")).toEqual([{ id: "2", backlog_rank: "0.000000" }]);
    expect(placeAt(tasks, "2", "up")).toEqual([{ id: "2", backlog_rank: "0.000000" }]);
    expect(placeAt(tasks, "1", "down")).toEqual([
      { id: "1", backlog_rank: "2000.000000" },
      { id: "2", backlog_rank: "1000.000000" },
      { id: "3", backlog_rank: "3000.000000" },
    ]);
  });

  it("returns null when nothing moves", () => {
    expect(placeAt(tasks, "1", "top")).toBeNull();
    expect(placeAt(tasks, "1", "up")).toBeNull();
    expect(placeAt(tasks, "3", "down")).toBeNull();
  });
});
