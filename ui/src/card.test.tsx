import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Avatars, Due, PriorityFlag, Progress } from "./bits";
import { CardView, describe as describeCard } from "./Card";
import type { Task } from "./plan";

const names = (email: string) => ({ "asha@acme.test": "Asha Rao" })[email] ?? email;
const task: Task = { id: "t1", number: "TASK-00012", subject: "Design the schema", status: "Working", priority: "High", exp_end_date: "2026-10-30", assigned_to: [{ user: "asha@acme.test" }, { user: "ravi.k@acme.test" }] };
const data = { task, names, today: "2026-11-10", blockedBy: [{ id: "t0", number: "TASK-00003", subject: "Gather needs", status: "Open" }], subtasks: { done: 3, total: 5 } };

describe("a card", () => {
  it("shows what tells one task from the rest", () => {
    const html = renderToStaticMarkup(<CardView data={data} />);
    for (const text of ["TASK-00012", "Design the schema", "3/5", ">AR<", ">RK<", "High priority"]) expect(html).toContain(text);
    expect(html).toContain("pj-late"); // due 30 October, today the 10th
    expect(html).toContain("Waits for TASK-00003 Gather needs");
  });

  it("has a name a screen reader can use, in the order a person reads", () => {
    expect(describeCard(data)).toBe("TASK-00012, Design the schema, Working, High priority, late, was due 2026-10-30, 3 of 5 sub-tasks done, waits for TASK-00003, assigned to Asha Rao, ravi.k@acme.test");
    expect(describeCard({ ...data, blockedBy: [], subtasks: undefined, task: { id: "x", number: "T-1", subject: "Plain", status: "Open", priority: "Medium" } })).toBe("T-1, Plain, Open");
  });

  it("marks a milestone, a selection and a card being carried", () => {
    const html = renderToStaticMarkup(<CardView data={{ ...data, blockedBy: [], subtasks: undefined, task: { ...task, is_milestone: true } }} selected held />);
    expect(html).toContain('aria-label="Milestone"');
    expect(html).toContain("data-selected");
    expect(html).toContain("data-held");
  });
});

describe("the small pieces", () => {
  it("draws progress inside its bounds", () => {
    expect(renderToStaticMarkup(<Progress value="42.4" />)).toContain('aria-valuenow="42"');
    expect(renderToStaticMarkup(<Progress value={250} />)).toContain('aria-valuenow="100"');
    expect(renderToStaticMarkup(<Progress value={null} />)).toContain('aria-valuenow="0"');
  });

  it("flags only the priorities that stand out, and shows a date only when there is one", () => {
    expect(renderToStaticMarkup(<PriorityFlag priority="Medium" />)).toBe("");
    expect(renderToStaticMarkup(<PriorityFlag priority="Urgent" />)).toContain("Urgent priority");
    expect(renderToStaticMarkup(<Due day={null} />)).toBe("");
    expect(renderToStaticMarkup(<Due day="2026-11-02" late />)).toContain("pj-late");
  });

  it("shows how many more people there are than marks", () => {
    const html = renderToStaticMarkup(<Avatars emails={["a@x.test", "b@x.test", "c@x.test", "d@x.test", "e@x.test"]} max={3} />);
    expect(html).toContain("+2");
    expect(renderToStaticMarkup(<Avatars emails={[]} />)).toBe("");
  });
});
