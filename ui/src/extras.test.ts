import { describe, expect, it } from "vitest";
import { cardFields, filterFields, shown } from "./extras";

const field = (name: string, type: string, extra: object = {}) => ({ name, label: name.replace("x_", "").toUpperCase(), type, ...extra });
const meta = {
  fields: [
    field("subject", "data", { in_list: true }),
    field("x_zone", "select", { options: ["North", "South"], in_list: true, in_filter: true }),
    field("x_customer", "link", { in_list: true }),
    field("x_secret", "data", { in_list: true, can_read: false }),
    field("x_hours", "decimal", { in_list: true }),
    field("x_done", "check", { in_list: true, in_filter: true }),
    field("x_review", "date", { in_list: true }),
    field("client_visible", "check", { in_filter: true }),
  ],
  form: [{ fields: ["subject", "x_done", "x_hours", "x_zone", "x_review"] }],
};

describe("added fields", () => {
  it("puts up to three plain fields on a card, in form order, and skips fixed, unreadable and link fields", () => {
    expect(cardFields(meta).map((e) => e.name)).toEqual(["x_done", "x_hours", "x_zone"]);
  });

  it("offers choices and ticks as filters, not the board's own", () => {
    expect(filterFields(meta).map((e) => e.name)).toEqual(["x_zone", "x_done"]);
    expect(filterFields(meta)[0].options).toEqual(["North", "South"]);
  });

  it("shows each kind of value, and nothing for an empty one", () => {
    const of = (name: string) => cardFields({ fields: meta.fields, form: [{ fields: [name] }] })[0];
    expect(shown(null, of("x_zone"))).toBeNull();
    expect(shown("", of("x_zone"))).toBeNull();
    expect(shown("North", of("x_zone"))).toBe("North");
    expect(shown(true, of("x_done"))).toBe("DONE");
    expect(shown(false, of("x_done"))).toBeNull();
    expect(shown("2.500000000", of("x_hours"))).toBe("2.5");
    expect(shown("2026-11-30", of("x_review"))).toContain("30");
    expect(shown("x".repeat(60), { name: "x_note", label: "Note", type: "data" })).toBe(`${"x".repeat(40)}…`);
  });
});
