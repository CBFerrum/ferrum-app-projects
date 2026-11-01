import { describe, expect, it } from "vitest";
import type { Task } from "./plan";
import { byRank, GAP, place, rankOf, STEP } from "./rank";

const t = (id: string, rank: string | number | null = null, number = id): Task => ({ id, number, rank });
const ids = (xs: Task[]) => xs.map((x) => x.id);

describe("manual order", () => {
  it("puts ranked tasks first by rank, then the rest in the order they were made", () => {
    const tasks = [t("c", null, "TASK-00003"), t("b", "2000.000000000", "TASK-00002"), t("a", 1500, "TASK-00001"), t("d", null, "TASK-00010"), t("e", null, "TASK-00004")];
    expect(ids(tasks.sort(byRank))).toEqual(["a", "b", "c", "e", "d"]);
  });

  it("reads a rank the way the server sends it", () => {
    expect(rankOf({ rank: "1500.250000000" })).toBe(1500.25);
    expect(rankOf({ rank: null })).toBeNull();
    expect(rankOf({ rank: "" })).toBeNull();
    expect(rankOf({ rank: "x" })).toBeNull();
  });

  it("breaks a tie by id, so every browser shows the same order", () => {
    expect(ids([t("b", 5), t("a", 5)].sort(byRank))).toEqual(["a", "b"]);
  });
});

describe("dropping a card", () => {
  const col = [t("a", 1000), t("b", 2000), t("c", 4000)];

  it("takes the middle of the two cards it lands between, and writes only itself", () => {
    expect(place(col, 1)).toEqual({ rank: "1500.000000", also: [] });
    expect(place(col, 2)).toEqual({ rank: "3000.000000", also: [] });
  });

  it("goes a step beyond the first or the last", () => {
    expect(place(col, 0)).toEqual({ rank: "0.000000", also: [] });
    expect(place(col, 3)).toEqual({ rank: "5000.000000", also: [] });
    expect(place(col, 99).rank).toBe("5000.000000");
    expect(place(col, -4).rank).toBe("0.000000");
  });

  it("starts an empty column at one step", () => {
    expect(place([], 0)).toEqual({ rank: `${STEP}.000000`, also: [] });
  });

  it("lays the column out afresh when a neighbour has no rank yet", () => {
    const mixed = [t("a", 1000), t("b"), t("c")];
    const p = place(mixed, 1);
    expect(p.rank).toBe("2000.000000");
    // a stays at 1000; the card takes 2000; b and c follow it
    expect(p.also).toEqual([
      { id: "b", rank: "3000.000000" },
      { id: "c", rank: "4000.000000" },
    ]);
    expect(place([t("a"), t("b")], 0)).toEqual({
      rank: "1000.000000",
      also: [
        { id: "a", rank: "2000.000000" },
        { id: "b", rank: "3000.000000" },
      ],
    });
  });

  it("lays the column out afresh when two ranks are too close to halve again", () => {
    const tight = [t("a", 1000), t("b", 1000 + GAP / 2), t("c", 2000)];
    const p = place(tight, 1);
    expect(p.rank).toBe("2000.000000");
    expect(p.also.map((x) => x.id)).toEqual(["b", "c"]);
    // the same ranks twice
    expect(place([t("a", 7), t("b", 7)], 1).also.length).toBeGreaterThan(0);
  });

  it("does not rewrite a card whose rank would be what it already is", () => {
    const p = place([t("a", 1000), t("b", 2000), t("c")], 3);
    // b has a rank and c has none, so the card lands after c: everything is ranked again, a and b unchanged
    expect(p.also).toEqual([{ id: "c", rank: "3000.000000" }]);
    expect(p.rank).toBe("4000.000000");
  });

  it("keeps the order a drop asked for once every rank is written", () => {
    const column = [t("a"), t("b"), t("c"), t("d")];
    const p = place(column, 2);
    const next = [...column.map((c) => ({ ...c, rank: p.also.find((x) => x.id === c.id)?.rank ?? c.rank })), { ...t("moved"), rank: p.rank }];
    expect(ids(next.sort(byRank))).toEqual(["a", "b", "moved", "c", "d"]);
  });
});

describe("dropping a card, over many columns", () => {
  const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

  it("always puts the card where it was dropped and leaves the rest in their order", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const rand = rng(seed);
      const pick = (n: number) => Math.floor(rand() * n);
      const n = 1 + pick(9);
      // Some tasks ranked (with gaps from huge down to hardly any), the rest not yet.
      const ranked = pick(n + 1);
      let at = 1000 * (1 + pick(5));
      const column: Task[] = Array.from({ length: n }, (_, i) => {
        at += [1000, 10, 0.5, 0.00002, 0.000001, 0][pick(6)];
        return t(`t${i}`, i < ranked ? at : null, `TASK-${String(i).padStart(5, "0")}`);
      });
      const order = [...column].sort(byRank);
      const moved = order[pick(n)];
      const others = order.filter((x) => x !== moved);
      const place_ = pick(others.length + 1);
      const p = place(others, place_);
      const changed = new Map(p.also.map((a) => [a.id, a.rank]));
      const next = [...others.map((o) => ({ ...o, rank: changed.get(o.id) ?? o.rank })), { ...moved, rank: p.rank }].sort(byRank);
      const want = [...others.slice(0, place_), moved, ...others.slice(place_)].map((x) => x.id);
      expect(next.map((x) => x.id), `seed ${seed}: ${JSON.stringify(column.map((c) => c.rank))} moving ${moved.id} to ${place_}`).toEqual(want);
    }
  });
});
