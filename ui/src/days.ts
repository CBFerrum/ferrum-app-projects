// Calendar days as whole numbers, so dates add and compare without time zones in the way. A date
// here is `YYYY-MM-DD`, as the server stores it; a day is never a moment.

const DAY = 86_400_000;

export const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Days since 1970-01-01. */
export const dayNumber = (day: string): number => Math.round(Date.parse(`${day}T00:00:00Z`) / DAY);
export const dayOf = (n: number): string => new Date(n * DAY).toISOString().slice(0, 10);
export const addDays = (day: string, n: number): string => dayOf(dayNumber(day) + n);
export const diffDays = (from: string, to: string): number => dayNumber(to) - dayNumber(from);

/** Monday is 0, Sunday 6. */
export const weekday = (day: string): number => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
export const weekStart = (day: string): string => addDays(day, -weekday(day));
export const isWeekend = (day: string): boolean => weekday(day) >= 5;

/** The weekdays (Monday to Friday) from `from` to `to`, both counted. */
export function weekdaysIn(from: string, to: string): number {
  let n = 0;
  for (let d = dayNumber(from); d <= dayNumber(to); d++) if ((((d + 3) % 7) + 7) % 7 < 5) n++;
  return n;
}

/** "3 Nov": a day for a label, in the viewer's language. */
export const shortDay = (day: string): string => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
