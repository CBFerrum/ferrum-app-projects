// Small pieces several screens draw the same way: how far along something is, a person's mark, a
// priority flag, a due date.

import { Flag } from "lucide-react";
import { initials } from "@ferrum/client";
import { shortDay } from "./days";
import { mark, num } from "./plan";

export function Progress({ value, label = "Complete" }: { value: string | number | null | undefined; label?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(num(value))));
  return (
    <span className="pj-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <span style={{ width: `${pct}%` }} />
      <small>{pct}%</small>
    </span>
  );
}

/** A person as a round mark (from their name where it is known, else from their address); the
 *  name shows on hover and is read aloud. */
export function Avatar({ email, name }: { email: string; name?: string }) {
  return (
    <span className="pj-avatar" title={name || email} role="img" aria-label={name || email}>
      {name && name !== email ? initials(name) : mark(email)}
    </span>
  );
}

export function Avatars({ emails, names, max = 3 }: { emails: string[]; names?: (email: string) => string; max?: number }) {
  if (!emails.length) return null;
  const more = emails.length - max;
  return (
    <span className="pj-avatars">
      {emails.slice(0, max).map((e) => (
        <Avatar key={e} email={e} name={names?.(e)} />
      ))}
      {more > 0 && (
        <span className="pj-avatar pj-avatar-more" title={emails.slice(max).map((e) => names?.(e) || e).join(", ")}>
          +{more}
        </span>
      )}
    </span>
  );
}

/** A flag for a priority that deserves one (Medium, the usual, shows nothing). */
export function PriorityFlag({ priority, always }: { priority: string | null | undefined; always?: boolean }) {
  const p = priority ?? "Medium";
  if (p === "Medium" && !always) return null;
  return (
    <span className="pj-flag" data-priority={p} title={`${p} priority`}>
      <Flag size={12} aria-hidden="true" />
      <span className="sr-only">{p} priority</span>
    </span>
  );
}

/** The keys a screen answers to, behind a word in its toolbar. */
export function Keys({ keys }: { keys: [string, string][] }) {
  return (
    <details className="pj-keys">
      <summary>Keyboard</summary>
      <dl className="card">
        {keys.map(([key, what]) => (
          <div key={key}>
            <dt>
              <kbd className="kbd">{key}</kbd>
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/** A due date: red when it is past and the task is not done. */
export function Due({ day, late, label = "Due" }: { day: string | null | undefined; late?: boolean; label?: string }) {
  if (!day) return null;
  return (
    <span className={late ? "pj-late" : "faint"} title={`${late ? "Late: " : ""}${label.toLowerCase()} ${day}`}>
      {shortDay(day)}
    </span>
  );
}
