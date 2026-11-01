import { describe, expect, it } from "vitest";
import { grid, hoursIn, level, touches, weekEnd, weekLabel, weeksFrom } from "./workload";

describe("hours booked", () => {
  it("books the weekdays an allocation covers, at its daily hours", () => {
    const a = { from_date: "2026-11-02", to_date: "2026-11-13", hours_per_day: "6" };
    expect(hoursIn(a, "2026-11-02", "2026-11-08")).toBe(30); // a week of five days
    expect(hoursIn(a, "2026-11-09", "2026-11-15")).toBe(30); // the second week ends on the 13th
    expect(hoursIn(a, "2026-11-07", "2026-11-09")).toBe(6); // Saturday, Sunday, Monday
    expect(hoursIn(a, "2026-11-16", "2026-11-22")).toBe(0);
    expect(hoursIn({ ...a, to_date: "2026-11-04" }, "2026-11-02", "2026-11-08")).toBe(18);
  });

  it("knows the weeks and which allocations touch them", () => {
    expect(weeksFrom("2026-11-11", 3)).toEqual(["2026-11-09", "2026-11-16", "2026-11-23"]);
    expect(weekEnd("2026-11-09")).toBe("2026-11-15");
    expect(touches({ from_date: "2026-11-15", to_date: "2026-11-20" }, "2026-11-09")).toBe(true);
    expect(touches({ from_date: "2026-11-16", to_date: "2026-11-20" }, "2026-11-09")).toBe(false);
    expect(weekLabel("2026-11-02")).toBe(`${new Date("2026-11-02T00:00:00Z").toLocaleDateString(undefined, { day: "numeric", timeZone: "UTC" })} – ${new Date("2026-11-08T00:00:00Z").toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" })}`);
  });
});

describe("how full a week is", () => {
  it("is green up to 80 %, amber up to the whole week, red above, and clear when nothing is planned", () => {
    expect([0, 20, 32, 33, 40, 40.5].map((h) => level(h, 40))).toEqual(["free", "ok", "ok", "busy", "busy", "over"]);
  });

  it("lays out people by weeks from the report's rows, with a team row", () => {
    const rows = [
      { person: "ravi@acme.test", week: "2026-11-02", hours: "44", capacity: 40 },
      { person: "asha@acme.test", week: "2026-11-02", hours: "20.5", capacity: 40 },
      { person: "asha@acme.test", week: "2026-11-09", hours: "36", capacity: 40 },
      { person: "Asha@Acme.test", week: "2026-11-09", hours: "2", capacity: 40 },
    ];
    const g = grid(rows, ["2026-11-02", "2026-11-09", "2026-11-16"]);
    expect(g.people.map((p) => p.email)).toEqual(["asha@acme.test", "ravi@acme.test"]);
    expect(g.people[0].cells.map((c) => [c.hours, c.level])).toEqual([
      [20.5, "ok"],
      [38, "busy"],
      [0, "free"],
    ]);
    expect(g.people[1].cells[0]).toEqual({ week: "2026-11-02", hours: 44, capacity: 40, level: "over" });
    expect(g.people[1].peak).toBeCloseTo(1.1);
    expect(g.totals.map((c) => [c.hours, c.capacity])).toEqual([
      [64.5, 80],
      [38, 80],
      [0, 80],
    ]);
  });

  it("adds the people with nothing planned, in the order asked for", () => {
    const g = grid([{ person: "b@x.test", week: "2026-11-02", hours: 8 }], ["2026-11-02"], ["A@x.test", "c@x.test"], (e) => ({ "a@x.test": "Zed", "b@x.test": "Amy", "c@x.test": "Max" })[e] ?? e);
    expect(g.people.map((p) => [p.email, p.cells[0].level])).toEqual([
      ["b@x.test", "ok"],
      ["c@x.test", "free"],
      ["a@x.test", "free"],
    ]);
    expect(grid([], ["2026-11-02"]).people).toEqual([]);
    expect(grid([], ["2026-11-02"]).totals).toEqual([{ week: "2026-11-02", hours: 0, capacity: 0, level: "free" }]);
  });
});
