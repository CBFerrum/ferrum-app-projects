# Changelog

## 0.6.8

Rebuilt with Ferrum-Frontend a76295e: its pages show times on a person's own clock when they chose one on their Account page, while today and due dates stay on the workspace's day.

## 0.6.7

A task's activity and the day at the top of My work are on the workspace's clock, naming its zone when the browser's is another. Rebuilt with Ferrum-Frontend 24c3951, so its records' pages show times on the workspace's clock too, a draft numbered on submit is headed as a draft, and a record of an app that is not installed says so.

## 0.6.6

Rebuilt with Ferrum-Frontend bb60115: a record page reads an empty number or check as the server does, so an action whose condition needs one shows, and a workspace's settings open as their one record.

## 0.6.5

The actions ask for what they read: a project's Create Sales Invoice offered to invoice "optionally only up to a date" with no way to give one; a timesheet's needs its project when it has time on several; Complete Project's confirmation spoke of a force the page could not send. They now declare the day, the project and whether to cancel the open tasks (Yes/No; true from the API as before). Projects and ERP connector 0.1.1.

## 0.6.4

Time entered on a timesheet's page bills at the activity's rate. The page's preview filled a row's billing hours and billing rate with 0 before the row had its activity and times, and sent them back, so the server took them for a choice and every row billed nothing (found walking project to profit in a browser: three billable hours at 80 an hour came to 0.00). Zero now means the default, as it already did for activity costs: billing hours follow the hours, and the rate follows the person's activity cost or the activity type. To bill none of the time, untick Billable.

## 0.6.3

Rebuilt with Ferrum-Frontend 00dea07: in a workflow state that names what may change, the other fields show read-only, and the fields the state needs show required.

## 0.6.2

Rebuilt with Ferrum-Frontend daeadda: after an action runs, a record page shows what the action said it did rather than only that it is done.

## 0.6.1

Rebuilt with Ferrum-Frontend 80ff179: a field's label names its control for assistive technology, and a record whose title is a link shows that record's title, not its id.

## 0.6.0

- The board is worked by hand. Drag a card to another column or to another place in its own and it
  stays where you put it, for everyone; or move it from the keyboard (Shift and the arrow keys) or
  from its menu. A move shows at once and goes back, with the server's reason, if it is refused.
  Swimlanes by person or priority, filters, a sort order and a box to add tasks to a column are in
  the address, so a link shares the view. A task opens in a panel beside the board.
- A timeline you can use. Drag a bar to move it and its ends to resize it, drag the dot at its end
  onto another bar to make that one wait for it, click an empty row to give a task dates. Arrows
  join tasks that wait for others. Moving a task that others wait for first shows what would move
  and asks; the last change can be undone. Zoom by day, week, month or quarter; critical path.
- A page for each task with its whole story: sub-tasks, what it waits for and what waits for it, time
  logged against the estimate, issues raised on it, and everything that happened, with the comments.
  Tasks open on it from notifications and Home's My work.
- My work: what is on a person's plate across every project, by when it is due or by project, with
  the hours to go, what they are planned for this week against what they logged, and a tick to be
  done. Managers can look at anyone's.
- Planning, for Projects Managers: a grid of who is booked how much, week by week (the workload
  report), with the allocations behind each week to add, change or remove; and how the projects of a
  portfolio stand (the portfolio overview), the ones needing attention first.
- A project opens on a strip of how it stands: progress, hours against the estimate, cost, billed,
  open risks and issues, changes waiting for a decision.
- Tasks carry a hidden `rank`, the place on the board among tasks of the same status. Tasks made
  before this have none, and come after those that were moved, in the order they were made.
- Two requests of the app's own, for what a list cannot carry (child rows), both read with the
  caller's rights: `GET /api/app/projects/tasks?project=` gives a project's tasks with the people on
  each and what each waits for, and `GET /api/app/projects/time?task=` the time logged on a task.

## 0.5.0

- Risks, issues, change requests, resource allocations and portfolios, with workload and portfolio reports. Tasks can repeat.
- Personal data: a person's request now exports their timesheets and activity costs, and says why they are kept: they are billing and costing records.

## 0.4.1

- The interface starts faster: its first download holds the frame and the app's own pages, and
  lists, forms, reports and other apps' screens load when first opened (Ferrum
  docs/plan/apps-ui.md §12.9). The build keeps it within the size budget.

## 0.4.0

- Home's My work lists your open tasks (`/api/app/projects/work`, Ferrum docs/plan/apps-ui.md
  §12.8), due on their expected end, High and Urgent ones marked, read with your own rights.
- Record cards stay off the project list, My tasks, the board and the timeline, whose rows already
  show what a card would.

## 0.3.2

- Rebuilt with Ferrum-Frontend a8d4dda: under the platform's bar the records frame no longer shows
  a second bell (the bar has notifications).

## 0.3.1

- Someone added to a task's assignees is notified (kind `projects.assigned`, "Tasks assigned to
  you"), in the bar and by email unless they chose otherwise in Ferrum's bell; not the person who
  added them. Requires the platform with notification kinds (Ferrum 2fccf10).

## 0.3.0

- An interface of its own at /projects/ (Ferrum docs/plan/apps-ui.md U5), in `ui/` (built with
  Ferrum-Frontend's packages, `dist` committed and embedded as `UI`). Its home: the open projects
  with how far along they are, and your open tasks (late ones marked). The project view: the board
  (tasks by status, moved with each card's menu, added in place), the timeline (each task's
  expected dates as a bar, milestones as marks, today's line, the tasks without dates listed) and
  the time logged on the project. Live updates keep it current. Tasks, timesheets and the rest are
  lists and forms in the records frame.
- Launcher entry for Projects Users and Managers; Task and Project in the Create menu; /open of a
  project into the project view (before ERP's records of the shared projects) and of Projects'
  and the projects-erp connector's records into its forms.

## 0.2.0

- Projects works without ERP: it depends on the platform's core, parties and project_records (the
  shared Project record, which left the platform's core) instead of accounting and selling (Ferrum
  docs/plan/apps-ui.md §13).
- The connector app `projects-erp` (connectors/erp/app.yaml, package `projects_erp`, shipped with
  Projects, requiring Projects and ERP) brings invoicing: "Create Sales Invoice" on projects and
  timesheets, activity types' service items, projects' billing item and cost center, and the
  invoices' links to time logs and milestones. Fields keep their names, columns and data. Requires
  the platform 0.3.2.

## 0.1.0

- First release as a standalone Ferrum app (previously part of the Ferrum repository).
