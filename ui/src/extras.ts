// Fields a workspace added to tasks, on the board: the plain ones it marks to show in lists go on the card (three at
// most), the choices and ticks it marks as filters become the board's filters, and a choice can be its swimlanes. The
// two marks a workspace already sets on a field decide; nothing else is configured. Pure, so it is tested without a
// browser.

import { formatDecimal } from "@ferrum/client";
import { shortDay } from "./days";

export interface Extra {
  name: string;
  label: string;
  type: string;
  options?: string[];
}

interface FieldLike {
  name: string;
  label: string;
  type: string;
  options?: string[];
  in_list?: boolean;
  in_filter?: boolean;
  hidden?: boolean;
  can_read?: boolean;
}

interface MetaLike {
  fields?: FieldLike[];
  form?: { fields: string[] }[];
}

/** What the board draws of a task already (the server's own list), and what is never an added field. */
const FIXED = new Set([
  "number", "subject", "project", "status", "task_status", "status_category", "priority", "exp_start_date", "exp_end_date", "expected_hours",
  "actual_hours", "progress", "is_milestone", "parent_task", "rank", "sprint", "story_points", "backlog_rank", "version",
]);
/** The board's own filters, or ones that say nothing on a card of one project. */
const NOT_FILTERS = new Set(["project", "company", "task_status", "status", "status_category", "priority", "parent_task", "is_milestone", "client_visible", "exp_end_date", "sprint"]);
const PLAIN = new Set(["data", "select", "int", "decimal", "percent", "date", "check"]);

const extra = (f: FieldLike): Extra => ({ name: f.name, label: f.label, type: f.type, options: f.options });

/** The entity's fields in its form's order, the ones the form leaves out after. */
function ordered(meta: MetaLike | undefined): FieldLike[] {
  const fields = meta?.fields ?? [];
  const order = (meta?.form ?? []).flatMap((s) => s.fields);
  const at = (f: FieldLike) => (order.indexOf(f.name) < 0 ? order.length : order.indexOf(f.name));
  return [...fields].sort((a, b) => at(a) - at(b));
}

const readable = (f: FieldLike) => f.can_read !== false && !f.hidden;

/** Up to three added plain fields marked to show in lists, for the card. */
export function cardFields(meta: MetaLike | undefined): Extra[] {
  return ordered(meta)
    .filter((f) => f.in_list && readable(f) && PLAIN.has(f.type) && !FIXED.has(f.name))
    .slice(0, 3)
    .map(extra);
}

/** Up to four added choices and ticks marked as filters, in the entity's order. */
export function filterFields(meta: MetaLike | undefined): Extra[] {
  return (meta?.fields ?? [])
    .filter((f) => f.in_filter && readable(f) && (f.type === "select" || f.type === "check") && !NOT_FILTERS.has(f.name))
    .slice(0, 4)
    .map(extra);
}

/** A value as a card shows it: nothing when empty; a tick, when ticked, as its label; a number, a day or a text cut
 *  to forty characters. */
export function shown(value: unknown, e: Extra): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (e.type === "check") return value === true || value === 1 || value === "1" ? e.label : null;
  if (["int", "decimal", "percent"].includes(e.type)) return formatDecimal(String(Number(value)));
  if (e.type === "date" && typeof value === "string") return shortDay(value.slice(0, 10));
  const text = String(value);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}
