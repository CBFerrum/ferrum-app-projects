// A task as a card on the board: what a person needs to tell it from the rest at a glance, a menu of
// what can be done to it without opening it, and the pieces that make it draggable.

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Diamond, Ellipsis, ListChecks, Lock } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { Link } from "react-router";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@ferrum/kit/primitives";
import { Avatars, Due, PriorityFlag } from "./bits";
import { assignees, CHOOSABLE, late, PRIORITIES, type Task } from "./plan";
import { t, isolate } from "@ferrum/client";

export interface CardData {
  task: Task;
  names: (email: string) => string;
  today: string;
  /** The tasks this one waits for that are not completed. */
  blockedBy: Task[];
  subtasks?: { done: number; total: number };
}

/** The words a screen reader gets for a card, in the order a sighted person reads it. */
export function describe({ task, today, blockedBy, subtasks, names }: CardData): string {
  const people = assignees(task).map(names);
  return [
    task.number,
    task.subject,
    task.status,
    task.priority && task.priority !== "Medium" ? `${task.priority} priority` : null,
    task.exp_end_date ? `${late(task, today) ? "late, was due" : "due"} ${task.exp_end_date}` : null,
    subtasks ? `${subtasks.done} of ${subtasks.total} sub-tasks done` : null,
    blockedBy.length ? `waits for ${blockedBy.map((b) => b.number ?? b.subject).join(", ")}` : null,
    people.length ? `assigned to ${people.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

export function CardView({ data, selected, held, menu, ...rest }: { data: CardData; selected?: boolean; held?: boolean; menu?: ReactNode } & HTMLAttributes<HTMLElement>) {
  const { task, names, today, blockedBy, subtasks } = data;
  const isLate = late(task, today);
  return (
    <article className="pj-card" data-selected={selected || undefined} data-held={held || undefined} data-late={isLate || undefined} aria-label={describe(data)} {...rest}>
      <div className="pj-card-top">
        <span className="pj-card-id">
          {task.is_milestone && <Diamond size={11} role="img" aria-label={t("Milestone")} className="pj-milestone-mark" />}
          {isolate(task.number ?? "")}
        </span>
        {menu}
      </div>
      <p className="pj-card-title">{isolate(task.subject ?? "")}</p>
      <div className="pj-card-facts">
        <PriorityFlag priority={task.priority} />
        <Due day={task.exp_end_date} late={isLate} />
        {subtasks && (
          <span className="pj-chip" title={t("{done} of {total} sub-tasks done", { done: subtasks.done, total: subtasks.total })}>
            <ListChecks size={12} aria-hidden="true" />
            {subtasks.done}/{subtasks.total}
          </span>
        )}
        {blockedBy.length > 0 && (
          <span className="pj-chip pj-chip-lock" title={t("Waits for {value}", { value: blockedBy.map((b) => `${b.number ?? ""} ${b.subject ?? ""}`.trim()).join(", ") })}>
            <Lock size={11} aria-hidden="true" />
          </span>
        )}
        <Avatars emails={assignees(task)} names={names} />
      </div>
    </article>
  );
}

export interface CardActions {
  onOpen: (task: Task) => void;
  onStatus: (task: Task, status: string) => void;
  onPriority: (task: Task, priority: string) => void;
  /** Takes the viewer on or off the task. */
  onMine: (task: Task) => void;
  onCancel: (task: Task) => void;
}

/** Stops a press in the menu from being taken for the card's: opening it, or starting a drag. */
const apart = {
  onMouseDown: (e: { stopPropagation: () => void }) => e.stopPropagation(),
  onTouchStart: (e: { stopPropagation: () => void }) => e.stopPropagation(),
  onKeyDown: (e: { stopPropagation: () => void }) => e.stopPropagation(),
  onClick: (e: { stopPropagation: () => void }) => e.stopPropagation(),
};

export function CardMenu({ task, me, canWrite, actions }: { task: Task; me: string; canWrite: boolean; actions: CardActions }) {
  const mine = assignees(task).some((a) => a.toLowerCase() === me.toLowerCase());
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="pj-card-menu" aria-label={t("Actions for {value} {value2}", { value: task.number ?? "", value2: task.subject ?? "task" })} {...apart}>
          <Ellipsis size={15} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" {...apart}>
        <DropdownMenuItem onSelect={() => actions.onOpen(task)}>{t("Open")}</DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to={`/t/${task.id}`}>{t("Open the task page")}</Link>
        </DropdownMenuItem>
        {canWrite && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>{t("Status")}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent {...apart}>
                <DropdownMenuRadioGroup value={task.status === "Overdue" ? "Open" : (task.status ?? "Open")} onValueChange={(s) => actions.onStatus(task, s)}>
                  {CHOOSABLE.map((s) => (
                    <DropdownMenuRadioItem key={s} value={s}>
                      {isolate(s)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>{t("Priority")}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent {...apart}>
                <DropdownMenuRadioGroup value={task.priority ?? "Medium"} onValueChange={(p) => actions.onPriority(task, p)}>
                  {PRIORITIES.map((p) => (
                    <DropdownMenuRadioItem key={p} value={p}>
                      {isolate(p)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {me && <DropdownMenuItem onSelect={() => actions.onMine(task)}>{mine ? t("Take me off it") : t("Assign to me")}</DropdownMenuItem>}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => actions.onCancel(task)}>
              {t("Cancel this task…")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A card that can be dragged and dropped among its column's. `children` is the card itself. */
export function SortableCard({ id, disabled, children }: { id: string; disabled: boolean; children: (props: HTMLAttributes<HTMLElement>, held: boolean) => ReactNode }) {
  // Cards slide out of the way of a carried one, unless the person asked for less motion.
  const calm = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled, transition: calm ? null : undefined });
  return (
    <li ref={setNodeRef} className="pj-slot" style={{ transform: CSS.Transform.toString(transform), transition }}>
      {children({ ...listeners } as unknown as HTMLAttributes<HTMLElement>, isDragging)}
    </li>
  );
}
