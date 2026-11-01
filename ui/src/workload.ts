// Who is planned for how much, week by week: the grid a planner reads, from the workload report
// (the server's figures: hours planned on weekdays against a week's capacity) and the allocations
// behind them. Pure, so it is tested without a browser.

import { addDays, weekdaysIn, weekStart } from "./days";

/** The report's own week: capacity is what it says in its rows, this only where a row is missing. */
export const CAPACITY = 40;

export interface Allocation {
  id: string;
  version?: number;
  person: string;
  project?: string | null;
  task?: string | null;
  from_date: string;
  to_date: string;
  hours_per_day: string | number;
  _titles?: Record<string, string>;
}

/** Hours an allocation books between two days: the weekdays it covers there, at its hours a day. */
export function hoursIn(a: Pick<Allocation, "from_date" | "to_date" | "hours_per_day">, from: string, to: string): number {
  const lo = a.from_date > from ? a.from_date : from;
  const hi = a.to_date < to ? a.to_date : to;
  return lo > hi ? 0 : weekdaysIn(lo, hi) * (Number(a.hours_per_day) || 0);
}

/** `n` Mondays from the week of `day`. */
export function weeksFrom(day: string, n: number): string[] {
  const first = weekStart(day);
  return Array.from({ length: n }, (_, i) => addDays(first, i * 7));
}

export const weekEnd = (week: string): string => addDays(week, 6);

/** Whether an allocation falls in a week at all. */
export const touches = (a: Pick<Allocation, "from_date" | "to_date">, week: string): boolean => a.from_date <= weekEnd(week) && a.to_date >= week;

export type Level = "free" | "ok" | "busy" | "over";

/** Nothing planned; up to 80 % of the week; up to the whole of it; more than it. */
export function level(hours: number, capacity: number): Level {
  if (hours <= 0) return "free";
  if (hours > capacity) return "over";
  return hours > capacity * 0.8 ? "busy" : "ok";
}

export interface WorkloadRow {
  person: string;
  week: string;
  hours: string | number;
  capacity?: number | string;
}

export interface Cell {
  week: string;
  hours: number;
  capacity: number;
  level: Level;
}

export interface Person {
  email: string;
  cells: Cell[];
  /** The most the person is booked in any week shown, as a share of the week. */
  peak: number;
}

export interface Grid {
  weeks: string[];
  people: Person[];
  /** The team: all the people shown, week by week. */
  totals: Cell[];
}

const cell = (week: string, hours: number, capacity: number): Cell => ({ week, hours, capacity, level: level(hours, capacity) });

/** The people down and the weeks across. `everyone` adds people with nothing planned; `by` orders them. */
export function grid(rows: WorkloadRow[], weeks: string[], everyone: string[] = [], by: (email: string) => string = (e) => e): Grid {
  const hours = new Map<string, number>();
  const room = new Map<string, number>();
  const who = new Set(everyone.map((e) => e.toLowerCase()));
  for (const r of rows) {
    const person = r.person.toLowerCase();
    who.add(person);
    hours.set(`${person}|${r.week}`, (hours.get(`${person}|${r.week}`) ?? 0) + (Number(r.hours) || 0));
    if (r.capacity !== undefined) room.set(`${person}|${r.week}`, Number(r.capacity) || CAPACITY);
  }
  const people = [...who]
    .sort((a, b) => by(a).localeCompare(by(b)) || a.localeCompare(b))
    .map((email): Person => {
      const cells = weeks.map((w) => cell(w, hours.get(`${email}|${w}`) ?? 0, room.get(`${email}|${w}`) ?? CAPACITY));
      return { email, cells, peak: Math.max(0, ...cells.map((c) => c.hours / c.capacity)) };
    });
  const totals = weeks.map((w, i) => cell(w, people.reduce((n, p) => n + p.cells[i].hours, 0), people.reduce((n, p) => n + p.cells[i].capacity, 0)));
  return { weeks, people, totals };
}

/** "36 h", "7.5 h". */
export const hoursText = (n: number): string => `${Number.isInteger(n) ? n : n.toFixed(1)} h`;

/** A week's range for a label: "2 – 8 Nov". */
export function weekLabel(week: string): string {
  const [a, b] = [new Date(`${week}T00:00:00Z`), new Date(`${weekEnd(week)}T00:00:00Z`)];
  const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleDateString(undefined, { ...o, timeZone: "UTC" });
  return a.getUTCMonth() === b.getUTCMonth() ? `${fmt(a, { day: "numeric" })} – ${fmt(b, { day: "numeric", month: "short" })}` : `${fmt(a, { day: "numeric", month: "short" })} – ${fmt(b, { day: "numeric", month: "short" })}`;
}
