// Manual order on the board. Every task may carry a `rank`, a decimal: dropping a card between two
// others gives it the middle of their ranks, so one drop writes one task. A task without a rank
// (every task before its column was first ordered, and every new one) comes after the ranked ones,
// in the order the tasks were made, so a new task lands last without anyone ranking it.

import type { Task } from "./plan";

/** The distance between ranks handed out when a column is laid out afresh. */
export const STEP = 1000;
/** Two ranks closer than this are laid out afresh instead of halved again: the server keeps nine
 *  decimals, and the middle of two nearer ranks would round onto one of them. */
export const GAP = 1e-5;

type Ranked = Pick<Task, "id" | "rank" | "number">;

export function rankOf(t: Pick<Task, "rank">): number | null {
  if (t.rank === null || t.rank === undefined || t.rank === "") return null;
  const n = Number(t.rank);
  return Number.isFinite(n) ? n : null;
}

/** Ranked tasks by rank, then the unranked by their number, then by id so every browser agrees. */
export function byRank(a: Ranked, b: Ranked): number {
  const [x, y] = [rankOf(a), rankOf(b)];
  if (x !== null && y !== null && x !== y) return x - y;
  if ((x === null) !== (y === null)) return x === null ? 1 : -1;
  return (a.number ?? "").localeCompare(b.number ?? "", undefined, { numeric: true }) || a.id.localeCompare(b.id);
}

/** A rank as the server takes it. */
const fix = (n: number): string => n.toFixed(6);

export interface Placement {
  /** The rank for the card that was dropped. */
  rank: string;
  /** Other cards of the column that had to be ranked again (none unless a neighbour had no rank
   *  yet, or two ranks had come too close). */
  also: { id: string; rank: string }[];
}

/** The rank for a card dropped at position `at` among `column`: the cards it lands among, in the
 *  order shown, without the card itself. */
export function place(column: Ranked[], at: number): Placement {
  const i = Math.max(0, Math.min(Math.trunc(at), column.length));
  const before = i > 0 ? rankOf(column[i - 1]) : undefined;
  const after = i < column.length ? rankOf(column[i]) : undefined;
  // `undefined`: nothing on that side; `null`: a card with no rank yet.
  if (before !== null && after !== null) {
    if (before === undefined) return { rank: fix(after === undefined ? STEP : after - STEP), also: [] };
    if (after === undefined) return { rank: fix(before + STEP), also: [] };
    const middle = Number(fix((before + after) / 2));
    if (after - before >= GAP && middle > before && middle < after) return { rank: fix(middle), also: [] };
  }
  // A neighbour without a rank, or no room left between two: the whole column gets ranks in order.
  const also: Placement["also"] = [];
  column.forEach((c, k) => {
    const rank = (k + (k >= i ? 1 : 0) + 1) * STEP;
    if (rankOf(c) !== rank) also.push({ id: c.id, rank: fix(rank) });
  });
  return { rank: fix((i + 1) * STEP), also };
}
