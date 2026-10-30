# Changelog

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
