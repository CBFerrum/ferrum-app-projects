import { describe, expect, it } from "vitest";
import { changes, counted, logsOf, story } from "./story";

const name = (field: string, value: unknown) => (value == null ? "" : field === "progress" ? `${value}%` : String(value));

describe("a task's story", () => {
  it("tells the changes people care about, in words, and leaves the record's bookkeeping out", () => {
    const e = { at: "2026-11-01T10:00:00Z", action: "update", diff: { status: ["Open", "Working"], rank: ["1000", "1500"], version: [1, 2], progress: ["20", "60"], actual_hours: ["1", "2"] } };
    expect(changes(e, name)).toEqual(["Status: Open → Working", "Progress: 20% → 60%"]);
    expect(changes({ ...e, diff: { exp_end_date: [null, "2026-11-20"] } }, name)).toEqual(["Due: 2026-11-20"]);
    expect(changes({ ...e, diff: { exp_end_date: ["2026-11-20", null] } }, name)).toEqual(["Due cleared"]);
    expect(changes({ ...e, diff: { assigned_to: { added: ["r1"], removed: [], changed: [] }, depends_on: { added: [], removed: ["r2"], changed: [] } } }, name)).toEqual(["The people on it changed", "What it waits for changed"]);
    expect(changes({ ...e, diff: { rank: ["1", "2"] } }, name)).toEqual([]);
  });

  it("puts changes, comments and time in one list, newest first", () => {
    const logs = logsOf([
      { timesheet: "ts1", user: "asha@acme.test", docstatus: 1, at: "2026-11-02T09:00:00Z", hours: "2.500000000", what: "Wired it up" },
      { timesheet: "ts2", user: "ravi@acme.test", docstatus: 0, at: "2026-11-04T09:00:00Z", hours: 1 },
    ]);
    const items = story(
      [
        { id: 1, at: "2026-11-01T08:00:00Z", action: "create", actor_name: "Asha" },
        { id: 2, at: "2026-11-03T08:00:00Z", action: "update", actor_name: "Asha", diff: { status: ["Open", "Working"] } },
        { id: 3, at: "2026-11-05T08:00:00Z", action: "update", actor: null, diff: { version: [1, 2] } },
        { id: 4, at: "2026-11-06T08:00:00Z", action: "update", actor: null, diff: { status: ["Open", "Overdue"] } },
      ],
      [{ id: "c1", body: "Looks right to me", author: "Ravi", created_at: "2026-11-03T12:00:00Z" }],
      logs,
      name,
    );
    expect(items.map((i) => [i.kind, i.title, i.who])).toEqual([
      ["status", "Status: Open → Overdue", "Ferrum"],
      ["time", "1 h logged (timesheet not submitted)", "ravi@acme.test"],
      ["comment", "Commented", "Ravi"],
      ["status", "Status: Open → Working", "Asha"],
      ["time", "2.5 h logged", "asha@acme.test"],
      ["created", "Task created", "Asha"],
    ]);
    expect(items[2].detail).toBe("Looks right to me");
    expect(items[4].detail).toBe("Wired it up");
  });

  it("counts only the time in submitted timesheets, as the task does", () => {
    const logs = logsOf([
      { timesheet: "a", user: "x", docstatus: 1, hours: "1.5" },
      { timesheet: "a", user: "x", docstatus: 1, hours: "2" },
      { timesheet: "b", user: "y", docstatus: 0, hours: "4" },
      { timesheet: "c", user: "z", docstatus: 2, hours: "8" },
    ]);
    expect(counted(logs)).toBe(3.5);
    expect(logs).toHaveLength(3); // the cancelled timesheet is left out
  });
});
