# Changelog

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
