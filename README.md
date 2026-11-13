<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
  <img alt="Ferrum Projects: plan the work, track the time, bill the client" src="docs/assets/banner-light.svg" width="100%">
</picture>

<br>

[![Version](https://img.shields.io/badge/version-0.9.1-b45309?style=flat-square)](CHANGELOG.md)
[![Licence: AGPL-3.0](https://img.shields.io/badge/licence-AGPL--3.0-blue?style=flat-square)](LICENSE)
[![Ferrum platform](https://img.shields.io/badge/runs%20on-Ferrum-2f5bea?style=flat-square)](https://github.com/CBFerrum/Ferrum)
![Rust](https://img.shields.io/badge/Rust-server-b7410e?style=flat-square&logo=rust)
![TypeScript](https://img.shields.io/badge/React-TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-data-336791?style=flat-square&logo=postgresql&logoColor=white)
![Tests](https://img.shields.io/badge/tests-16%20Rust%20%C2%B7%20105%20UI-16a34a?style=flat-square)

### Plan the work, log the time, and bill the client from one project record that also feeds your books.

Projects gives a team a board, a timeline, task trees with dependencies, weekly timesheets with approval, rate cards, milestone and time-and-materials invoices, and profitability read from the ledger. It is for service firms, agencies and internal teams who want work management and billing in the same system, and it replaces a task tool plus a time tracker plus a spreadsheet of invoices.

[💡 Why](#-why-projects) · [📸 Screenshots](#-screenshots) · [✨ Features](#-features) · [📊 Compare](#-how-it-compares) · [📍 Roadmap](#-roadmap) · [🚀 Install](#-install) · [🔧 Develop](#-develop)

</div>

## 💡 Why Projects

- 🧾 **From task to invoice in one system.** Time on a task becomes billable hours at the right rate, then a sales invoice, and cancelling the invoice releases the time again. Profitability reads costs straight from the ledger.
- 🤝 **A shared project record.** A project is a platform record that Helpdesk, Field Service and CRM link to, so a ticket, a visit and a deal can all point at the same project.
- 🔐 **Teams, private projects and a client portal.** A project lists its team and their roles. A private project is for its team alone. A customer's people can read the projects, tasks and time you share with them, and nothing internal.
- 🧭 **Plan the way you work.** Drag cards on the board, drag bars on the timeline, see what waits for what, and look at everyone's week in one grid.
- 🧩 **Statuses, workflows and templates are data.** Task statuses have categories, workflows belong to a project type, and a project saved as a template brings its tree back with dates moved onto working days.
- 🌍 **Arabic and Hindi built in**, right-to-left pages, and a workspace's own interface words.
- 🔓 **Open source and self-hosted.** AGPL-3.0, no per-seat price, your data in your PostgreSQL, readable by Ferrum's REST and MCP APIs under each person's permissions.

## 🎯 At a glance

| | |
|---|---|
| **Version** | 0.9.1 (package `projects` 0.4.1; connector `projects-erp` 0.3.0) |
| **Kind** | Its own interface at `/projects/` (home, project, task, my work, planning) with Ferrum's records screens for everything else |
| **What it adds** | 22 entities (15 records, 7 small tables) and extra fields on the shared Project and Customer records, 4 roles, 1 module with 5 reports, 3 project tabs, 1 notification kind and 1 message, 3 upkeep jobs, 3 own endpoints; the ERP connector adds invoicing fields and actions. No print formats. |
| **Depends on** | Ferrum platform `>=0.3.4, <0.4`; the platform's `core`, `parties` and `project_records` packages |
| **Works with** | ERP (invoicing, accounts), Helpdesk, Field Service, CRM (they link to projects), Objectives (key results name projects) |
| **Languages** | English, Arabic and Hindi (307 interface words and 235 names in each), right-to-left |
| **Tests** | 16 Rust tests (against a real PostgreSQL, including upgrades), 105 interface tests |
| **Licence** | AGPL-3.0-only |

## 📸 Screenshots

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/projects-projects-dark.webp"><img alt="Projects — all projects" src="docs/assets/screens/projects-projects-light.webp" width="100%"></picture>

<p align="center"><b>🗂️ All projects</b><br><sub>See every project with its customer, dates and progress, and open one.</sub></p>

<table>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/projects-project-dark.webp"><img alt="Projects — a project" src="docs/assets/screens/projects-project-light.webp"></picture>
<p><b>🧲 A project board</b><br><sub>Drag tasks between status columns, filter by person or priority, and read the project's figures at the top.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/projects-project-website-dark.webp"><img alt="Projects — a project in progress" src="docs/assets/screens/projects-project-website-light.webp"></picture>
<p><b>🛠️ A project in progress</b><br><sub>See overdue and working tasks on one board.</sub></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/projects-task-dark.webp"><img alt="Projects — a task" src="docs/assets/screens/projects-task-light.webp"></picture>
<p><b>✅ A task</b><br><sub>Update one task: its people, due date, status, time logged and history.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/projects-my-work-dark.webp"><img alt="Projects — my work" src="docs/assets/screens/projects-my-work-light.webp"></picture>
<p><b>🙋 My work</b><br><sub>See what is on your plate across projects, by due date or by project, with the week's planned and logged hours.</sub></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/projects-plan-dark.webp"><img alt="Projects — planning" src="docs/assets/screens/projects-plan-light.webp"></picture>
<p><b>📅 Planning</b><br><sub>See who is booked how much, week by week, and plan someone onto a project.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/projects-new-project-dark.webp"><img alt="Projects — new project" src="docs/assets/screens/projects-new-project-light.webp"></picture>
<p><b>➕ New project</b><br><sub>Create a project with its company, customer, billing method and dates.</sub></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/projects-task-list-dark.webp"><img alt="Tasks — list" src="docs/assets/screens/projects-task-list-light.webp"></picture>
<p><b>📋 Tasks</b><br><sub>Search and filter every task, as a list, board or calendar.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/projects-timesheet-list-dark.webp"><img alt="Timesheets — list" src="docs/assets/screens/projects-timesheet-list-light.webp"></picture>
<p><b>⏱️ Timesheets</b><br><sub>Read timesheets with their person, hours, amounts and status.</sub></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/projects-project-risk-list-dark.webp"><img alt="Risks — list" src="docs/assets/screens/projects-project-risk-list-light.webp"></picture>
<p><b>⚠️ Risks</b><br><sub>Track each project's risks by probability, impact and status.</sub></p>
</td>
<td width="50%"></td>
</tr>
</table>

<table>
<tr>
<td align="center" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/projects-projects-phone-dark.webp"><img alt="Projects — all projects" src="docs/assets/screens/projects-projects-phone-light.webp" width="260"></picture>
<p><b>📱 All projects (phone)</b><br><sub>Projects on a phone.</sub></p>
</td>
<td align="center" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/projects-task-list-phone-dark.webp"><img alt="Tasks — list" src="docs/assets/screens/projects-task-list-phone-light.webp" width="260"></picture>
<p><b>📱 Tasks (phone)</b><br><sub>Tasks on a phone.</sub></p>
</td>
</tr>
</table>


## ✨ Features

### 🗂️ Projects

- **Project** is the platform's shared record, extended by this app: status (Open, On Hold, Completed, Cancelled), priority (Low, Medium, High, Urgent), project manager, customer, company, expected start and end dates, notes, budget, a project type and a task workflow.
- **Actual dates** are worked out: the first and last submitted time log.
- **Billing method:** **Time and Materials**, **Fixed Price** (a contract value is required and must be above zero) or **Non-billable**.
- **Estimates:** estimated cost and estimated hours; **actual hours**, **timesheet cost**, **billable time** and **billed amount** are always recomputed from their sources under a row lock, never incremented, so cancellations and concurrent postings cannot make them drift.
- **% complete** by **Task Progress** or **Manual**. Task progress counts only tasks that have no live sub-tasks (a parent is its sub-tasks), weighted by expected hours (all alike when none has any), done as 100 %, cancelled left out.
- **Complete Project** refuses while tasks are open. Say yes to "Cancel Its Open Tasks" to cancel them first.
- **Project strip.** A project opens on tiles: progress, open tasks and how many are overdue, hours against the estimate, cost so far against the budget, billed against the contract value or billable time, open risks, open issues and changes waiting for a decision. Figures turn red when over.
- **Project list** on Home: open projects with how far along they are and what is late in them, with your soonest tasks.
- **Templates.** **Save as Template** keeps the task tree, dependencies, estimates and team, with each task's dates as days from the project's start and its assignee as a role on the team. **Create Project** from a template shifts the dates from the new start (onto the working days of a business calendar when one is named) and gives tasks to the team's people of each role. No time is booked on a template.
- **Project types** carry a default task workflow for their projects.
- **Priority, manager and type** are filters on the list.

### 🔐 Teams, private projects and the client portal

- **Team.** A project lists people and their role on it: **Manager** (changes the project and its tasks), **Member** (changes its tasks), **Viewer** (reads).
- **Private projects.** Tick Private and only the team (and Projects Managers) read the project, its tasks, risks, issues, change requests and allocations. Open projects are read by every Projects User. Erasing a person removes them from every team.
- **Client portal.** **Project Client** is a portal role an administrator gives to a customer's people, listed on the customer (Client People). They read, and change nothing: the customer's projects marked **Shared with the Client**, the tasks and milestones on them marked **Visible to the Client**, the approved timesheets whose time is all on a shared project, and, with ERP, the project's submitted invoices.
- **What the portal hides.** A project's notes, budget, team, manager, estimated cost, timesheet cost and baseline figures; a task's assignees; a timesheet's person, approvers and note; a time log's billing rate. These are hidden by the role's own rules, so they are left out of the record, lists, filters, sorting, search, reports, history and the app's own routes. Comments and files are not shared with portal people yet.

### ✅ Tasks

- **Task** has a subject, project, status, priority, parent task, assignees (several), expected start and end, expected hours, progress, actual hours, completed on and a description. Tasks nest to any depth. A parent must be in the same project.
- **Milestones.** A task can be a milestone, with a billing percent (see Billing).
- **Statuses with categories.** A status is a record with a category: **To Do**, **In Progress**, **Done** or **Cancelled**. A workflow lists statuses in order; a project uses its own workflow, else its type's, else the default. Out of the box, the Standard workflow has Open, Working, Pending Review, Overdue, Completed and Cancelled. What a status means (started, finished, cancelled) is its category, which is all the code reads: starting, finishing, dependencies, completing a project, billing, reports, the overdue job and the hand-over.
- **Overdue job.** A task in a To Do status whose expected end date has passed moves to that status's late status (Overdue by default), unless its project is completed or cancelled.
- **Four kinds of dependency**, each with a lag or lead in days: **Finish to Start**, **Start to Start**, **Finish to Finish**, **Start to Finish**. Each kind holds back starting or finishing until the other task allows it. Cycles are refused.
- **Auto-schedule.** With the setting on, a task's dates follow its predecessors on the settings' business calendar, its length kept; done and cancelled tasks stay where they are.
- **Repeating tasks.** Daily, weekly or monthly, until a date: the next is made when the current falls due, with the same people. A key keeps a re-run from making it twice.
- **Client visibility.** A task or milestone can be marked **Visible to the Client**.
- **Hand-over.** When a person leaves, their open tasks (To Do or In Progress) move to their manager.
- **Notification.** Someone added to a task's assignees is told (kind **Tasks assigned to you**), in the bar and by email unless they chose otherwise.
- **Billing percent and billed amount** on milestones; a milestone can be invoiced on its own.

### 🧲 The board

- **Columns from the project's workflow.** Drag a card to another column or to another place in its own and it stays where you put it, for everyone. Or move it from the keyboard (Shift and the arrow keys) or from its menu. A move shows at once and goes back, with the server's reason, if it is refused.
- **Swimlanes** by person or priority, filters (anyone, priority, due date, all tasks), a sort order (manual and others) and a box to add a task to a column.
- **In the address.** Lanes, filters and sort are in the page address, so a link shares the view.
- **A task opens in a panel** beside the board.
- A hidden `rank` keeps the order among tasks of the same status.

### 🗓️ The timeline

- **Drag a bar to move it and its ends to resize it.** Click an empty row to give a task dates. Drag the dot at a bar's end onto another bar to make that one wait for it.
- **Arrows** join tasks that wait for others. **Critical path** is marked.
- **Moving a task others wait for** first shows what would move, and asks. The last change can be undone.
- **Zoom** by day, week, month or quarter.

### 📖 A page for each task

Sub-tasks, what it waits for and what waits for it, time logged against the estimate, issues raised on it, and everything that happened, with the comments. Tasks open on it from notifications and My work.

### 🙋 My work

What is on a person's plate across every project: open, late, due today and hours to go, **by when it is due** or **by project**, with a tick to be done and a status picker on each row. A side card shows what they are planned for this week against what they logged. Managers can look at anyone's. The same list feeds Ferrum Home's **My work**, due on the task's expected end.

### 📅 Planning

For Projects Managers:

- **Capacity.** A grid of who is booked how much, week by week (8 or 12 weeks), with the allocations behind each week to add, change or remove, and CSV export. Capacity is the working days of a business calendar (its weekends and holidays), or Monday to Friday without one, at the working hours a day (8 unless said). Hours planned on a day nobody works count for nothing. Leave is not known here.
- **Portfolios.** How the projects of a portfolio stand, the ones needing attention first.

### ⏱️ Time

- **Timesheet** has a person, a project or several, and lines by **day and hours** (no clock times needed) or **from and to times**. A timesheet may be for a **week** (`week_start`).
- **Start Timer and Stop Timer** time today's line for a project, task and activity.
- **Overlap refused.** A person's time on two lines may not overlap.
- **Rates.** A line bills at the most specific **Rate Card** in force, then the person's **Activity Cost**, then the **Activity Type's** default. Costing rates (what the time costs you) follow the same order. Time entered on the timesheet's page bills at the activity's rate.
- **Rate cards** by project, customer, role on the project, person and activity, with dates. The most specific wins: project, then customer, role, person, activity; the latest start among equals. Each rate is chosen on its own.
- **Activity types and costs.** Kinds of work with default billing and costing rates and the service item they invoice as; per-person overrides.
- **Approval.** Submitting asks the approvers (every one of them): each of the project's managers, else their team managers, or the person's manager on their Project Person record, as Projects Settings says; never the person themselves. A rejection with a reason leaves the timesheet a draft to change and submit again. Approved, it is submitted and locked. A timesheet with no approver goes straight through. A workspace can switch the policy off or replace it.
- **Reminders.** From the settings' weekday, people whose time that week is short of their `weekly_hours` are told once a week.
- **Status:** Draft, Submitted, Partly Billed, Billed, Cancelled.

### 🧾 Billing

- **Time and materials.** **Create Sales Invoice** on a project (up to a day) or on a timesheet invoices the unbilled billable time, one line per activity and rate, with the activity's service item. Needs the ERP connector.
- **Fixed price.** Milestones carry a percent of the contract value, at most 100 % in total. **Create Milestone Invoice** bills a milestone's share.
- **Marked on submit, undone on cancel.** Time is marked billed when the invoice is submitted, never when the draft is made, so a deleted draft leaves everything unbilled and two drafts can never bill the same time. Cancelling the invoice releases the time and milestones.
- **Another currency.** A project can be invoiced in another currency at the day's exchange rate; its figures stay in the company's.
- **Cost center** and **milestone billing item** per project.

### 💹 Profitability and budgets

- **Project Profitability** report: billed revenue against timesheet and ledger expense costs, by project, with the estimated cost and forecast margin of fixed price projects.
- **Budget and baseline.** An **approved change request** moves the plan: the expected end date by its days, the estimated hours by its hours, the estimated cost and a set budget by its cost, and a fixed price's contract value by its effect. Before the first approved change, the plan as it was is kept as the project's **baseline** (end date, hours, cost, budget, contract value) with the day and the number of changes since. A milestone billed afterwards bills its share of the new contract value.

### ⚠️ Risks, issues and changes

- **Risks** have probability and impact (Low, Medium, High), a computed exposure, status (Open, Mitigating, Accepted, Closed), owner, review date and mitigation.
- **Issues** have severity (Low to Critical), status (Open, In Progress, Resolved, Closed), owner, a task they were raised on and a resolution.
- **Change requests** are submitted documents with effects (days, hours, cost, price), decided **Approved** or **Rejected** by someone other than whoever raised them, with a note. Approving moves the plan as above.

### 🧮 Resources and portfolios

- **Resource allocations** say who is planned onto a project, when, and how many hours a day. Over-allocation is reported, not refused: planners often know better.
- **Portfolios** group projects. **Portfolio Overview** shows how each stands, task counts, risks and issues, the ones needing attention first.
- **Projects Settings:** who approves timesheets (the project manager or the person's manager), whether tasks' dates follow their dependencies, the schedule calendar, the week's first day and the reminder weekday.

### 📊 Reports

| Report | What it shows |
|---|---|
| **Project Profitability** | Billed revenue against costs from timesheets and the ledger, per project; forecast margin |
| **Timesheet Summary** | Hours by person, project and activity over a period |
| **Task Overview** | Tasks by project and assignee with their status |
| **Workload** | Hours planned per person per week against capacity, who is over and when |
| **Portfolio Overview** | How each portfolio's projects stand |

### 🔌 For other apps and agents

- `GET /api/app/projects/work` feeds Ferrum Home's My work.
- `GET /api/app/projects/tasks?project=` gives a project's tasks with the people on each and what each waits for. `GET /api/app/projects/time?task=` gives the time logged on a task. Both read with the caller's rights.
- Every entity has Ferrum's REST and MCP API under each person's permissions, search, an audit trail, exports and live updates.
- A small assistant note tells Ferrum's assistant what the records mean and suggests "Which tasks on my projects are overdue?", "How many hours were logged this week, by project?", "Which projects are over budget?" and "What time is not billed yet?".

### 🔐 Roles and permissions

| Role | What it can do |
|---|---|
| **Projects Manager** | Plans projects and tasks, sees costs and billing fields, sets rates, statuses, workflows and settings, decides change requests, bills customers |
| **Projects User** | Records own time, works on tasks assigned to them, reads open projects and those they are on, writes by their role on the project |
| **Project Client** | A portal role for a customer's people: reads shared projects, visible tasks, approved timesheets and invoices, and nothing internal |
| **Accounts Manager** | Reads timesheets, rates and tasks' billing for finance |

Costing and billing fields sit in permission groups (`costing`, `billing`), so a role can see tasks without seeing money.

### 🧾 Personal data

An erasure request removes a person from every project team and from a customer's client people. Timesheets, activity costs, project people and rate cards are kept as billing, costing and staffing records, and are included in a person's export.

## 🧭 How it works

```mermaid
flowchart LR
    T["Task"] --> TS["Timesheet line<br/>no overlapping time"]
    TS -->|"submit"| AP["Approval"]
    AP -->|"approved"| TM["Unbilled time"]
    TM -->|"Create Sales Invoice"| INV["Sales invoice (ERP)"]
    M["Milestone"] -->|"Create Milestone Invoice"| INV
    INV -->|"cancelled"| R["Time and milestones released"]
    TM --> P["Profitability<br/>costs from the ledger"]
    CR["Change request approved"] -->|"moves plan, keeps baseline"| PR["Project"]
```

A line of time on a task is checked against overlaps, goes through approval, and becomes billable time. The invoice marks it billed on submit and releases it on cancel. Approved change requests move the plan and keep the baseline.

```mermaid
flowchart TD
    PRJ["Project (shared record)"] --> HD["Helpdesk, Field Service, CRM link to it"]
    PRJ --> TK["Tasks and dependencies"]
    PRJ --> TSH["Timesheets"]
    TSH --> ERP["ERP: invoices, accounts"]
    PRJ --> OB["Objectives: key results name projects"]
    PRJ --> PORT["Client portal"]
```

Projects extends the platform's Project record with its own fields, so other apps need nothing from this one to link to a project.

## 🧱 Data model

| Entity | What it is | Key fields or states |
|---|---|---|
| **Project** (platform record, extended) | A body of work for a customer | status, priority, manager, billing method, contract value, budget, estimates, % complete, team, private, shared with the client, baseline |
| **Task** | A unit of work, nested | subject, project, status and category, priority, parent, milestone, dates, hours, assignees, dependencies, repeat, billing percent |
| **Timesheet** (with lines) | Time recorded by a person | person, week, lines (day, hours, activity, billable, rate), status, approvers |
| **Activity Type** / **Activity Cost** | Kinds of work, and per-person rates | billing and costing rate, service item |
| **Rate Card** | A rate by project, customer, role, person or activity, with dates | rates, valid from and to |
| **Task Status** / **Task Workflow** / **Project Type** | What a task can be, in what order, per kind of project | category, order, late status, default |
| **Project Person** | Manager and weekly hours of a person who records time | manager, weekly hours |
| **Projects Settings** | Approval, scheduling and reminders | approver, calendar, week start, reminder day |
| **Risk** / **Issue** | A project's risks and issues | probability, impact, exposure; severity, status |
| **Change Request** | A submitted request to change the scope | effects, decision, decided by |
| **Resource Allocation** | Who is planned when, for how many hours a day | person, project, dates, hours per day |
| **Portfolio** | A group of projects | projects, owner |
| Small tables | Team members, client people, task assignees, dependencies, workflow statuses, timesheet lines, portfolio projects | |

```mermaid
erDiagram
    Project ||--o{ Task : has
    Project ||--o{ Timesheet : "time on"
    Task ||--o{ Task : "sub-tasks"
    Task }o--o{ Task : "depends on"
    Timesheet ||--|{ TimesheetDetail : lines
    ActivityType ||--o{ ActivityCost : "per-person rate"
    Project ||--o{ ChangeRequest : "scope changes"
    Project ||--o{ ProjectRisk : risks
    Project ||--o{ ProjectIssue : issues
    Project ||--o{ ResourceAllocation : "planned onto"
    Portfolio }o--o{ Project : groups
    TaskWorkflow ||--o{ TaskStatus : orders
    ProjectType ||--o{ Project : "default workflow"
```

Reports: 5 (above). Print formats: none. Scheduled jobs: marking overdue tasks, making repeating tasks, and reminding people whose week's time is short.

## 🔌 Integrations

| With | How | Needs |
|---|---|---|
| **ERP** (connector `projects-erp`) | Sales invoices for time and milestones, service items, cost centers, invoice currency, invoices on the portal | ERP `>=0.1`, installed alongside |
| **Helpdesk, Field Service, CRM** | They link to the shared Project record | Nothing from Projects |
| **Objectives** | A key result names the projects that move it; an objective its portfolio | Objectives installed |
| **Business calendars** | Working days for templates, auto-schedule and capacity | A calendar in the workspace |
| **Notifications and Home** | Assigned-to-you, missing-time reminders, My work | None |
| **MCP and REST** | AI agents and scripts under each person's permissions | An API key or sign-in |

## 📊 How it compares

Projects is compared with Asana, Atlassian Jira, monday.com, Microsoft Project, Smartsheet and the open-source OpenProject. Those are work-management tools. Few of them bill clients or know your ledger, which is the point of Projects.

| Capability | Ferrum Projects | Asana | Jira | monday.com | MS Project | Smartsheet | OpenProject |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Tasks, sub-tasks and milestones | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Board with drag and drop, swimlanes | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Timeline or Gantt, drag to schedule | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Four kinds of dependency with lag | ✅ | 🟡¹ | 🟡¹ | 🟡¹ | ✅ | ✅ | 🟡¹ |
| Critical path | ✅ | 🟡¹ | 🟡¹ | 🟡¹ | ✅ | ✅ | 🟡¹ |
| Baselines | 🟡² | 🟡¹ | 🟡¹ | 🟡¹ | ✅ | ✅ | 🟡¹ |
| Project templates | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Statuses and workflows you define | ✅ | ✅ | ✅ | ✅ | 🟡¹ | ✅ | ✅ |
| Custom fields | 🟡³ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Teams, roles and private projects | ✅ | ✅ | ✅ | ✅ | 🟡¹ | ✅ | ✅ |
| Client or guest portal | ✅ | 🟡¹ | 🟡¹ | 🟡¹ | 🟡¹ | 🟡¹ | 🟡¹ |
| Recurring tasks | 🟡⁴ | ✅ | 🟡¹ | ✅ | 🟡¹ | ✅ | 🟡¹ |
| Workload and capacity | 🟡⁵ | ✅ | 🟡¹ | ✅ | ✅ | ✅ | 🟡¹ |
| Timesheets with a timer | ✅ | 🟡¹ | 🟡¹ | ✅ | 🟡¹ | 🟡¹ | ✅ |
| Timesheet approval | ✅ | 🟡¹ | 🟡¹ | 🟡¹ | 🟡¹ | 🟡¹ | 🟡¹ |
| Rate cards (project, client, role, person) | ✅ | ❌ | ❌ | 🟡¹ | ✅ | 🟡¹ | ✅ |
| Budgets and costs | ✅ | 🟡¹ | 🟡¹ | 🟡¹ | ✅ | 🟡¹ | ✅ |
| Invoice time and milestones | ✅ | ❌ | 🟡¹ | 🟡¹ | ❌ | 🟡¹ | ❌ |
| Profitability from the company ledger | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Invoice in the client's currency | ✅ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ |
| Risks, issues and change requests with approval | ✅ | ❌ | 🟡¹ | 🟡¹ | 🟡¹ | 🟡¹ | 🟡¹ |
| Portfolio view | 🟡⁶ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡¹ |
| Sprints and backlog | ❌ | 🟡¹ | ✅ | ✅ | 🟡¹ | 🟡¹ | ✅ |
| Burndown and velocity | ❌ | 🟡¹ | ✅ | ✅ | 🟡¹ | 🟡¹ | ✅ |
| Earned value | ❌ | 🟡¹ | 🟡¹ | 🟡¹ | ✅ | 🟡¹ | 🟡¹ |
| Automation rules | 🟡⁷ | ✅ | ✅ | ✅ | 🟡¹ | ✅ | 🟡¹ |
| Task approvals | ❌ | ✅ | 🟡¹ | 🟡¹ | ❌ | ✅ | 🟡¹ |
| Status updates with project health | ❌ | ✅ | 🟡¹ | ✅ | 🟡¹ | ✅ | 🟡¹ |
| Email to task | ❌ | ✅ | ✅ | ✅ | 🟡¹ | 🟡¹ | ✅ |
| Slack, Teams and Git integrations | ❌ | ✅ | ✅ | ✅ | 🟡¹ | ✅ | 🟡¹ |
| Calendar feeds (iCalendar) | ❌ | ✅ | 🟡¹ | ✅ | 🟡¹ | ✅ | ✅ |
| Import from Jira, Asana, MS Project, Excel | 🟡⁸ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡¹ |
| Native mobile apps | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡¹ |
| Arabic and Hindi, right to left | ✅ | 🟡¹ | 🟡¹ | 🟡¹ | 🟡¹ | 🟡¹ | 🟡¹ |
| Open source | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Self-hosted | ✅ | ❌ | 🟡⁹ | ❌ | 🟡⁹ | ❌ | ✅ |
| One data set with accounting, CRM, helpdesk and HR | ✅ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ |
| No per-seat price | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | 🟡¹⁰ |

<sub>¹ Present in some form or not confirmed; check the product and its edition. ² One project baseline of the end date, hours, cost, budget and contract value, kept by the first approved change request; no saved baselines on demand and no variance on the timeline. ³ A workspace can add fields to tasks and projects and they appear in forms and lists; the board, card and task page draw a fixed set. ⁴ Daily, weekly or monthly, made when the task falls due; it copies the people and a fixed list of fields, not sub-tasks. ⁵ From allocations and working days of a calendar; task estimates do not count and leave is not known. ⁶ A portfolio overview of task counts, risks and issues; no budget or margin roll-up. ⁷ Automations are built by an administrator for the whole workspace, not per project. ⁸ Flat CSV import of records. ⁹ An on-premises edition exists with a different feature set. ¹⁰ The community edition is free; the enterprise edition is priced per user.</sub>

### 🏆 Where Projects stands out

- **Billing and the books are the same system.** Time becomes an invoice, cancelling it releases the time, and profitability reads the ledger.
- **Rate cards** with a clear precedence, and invoices in the client's currency at the day's rate.
- **Approval, teams, privacy and a read-only client portal** with the internal fields hidden by permission rules, not by interface.
- **Derived figures never drift**: hours, costs and billed amounts are recomputed from their sources.
- **Statuses with categories**, workflows per project type, templates with working-day dates.
- **A shared project record** that Helpdesk, Field Service and CRM already link to.
- **Open source, self-hosted, no per-seat price**, with REST and MCP for agents.

### 🚧 Where the leaders are still ahead

- **Agile work:** sprints, backlogs, story points, burndown and velocity.
- **Integrations:** Slack, Teams, Git, email to task, calendar feeds and migration importers.
- **Project health:** status updates with a health rating, portfolio roll-ups of money and dates, dashboards.
- **Scheduling depth:** several baselines, earned value, effort-driven scheduling, Gantt export.
- **Mobile apps and offline use.**
- **Task approvals, proofing and automations owned by a project manager.**

> [!NOTE]
> Leader columns are from public product information as of November 2026 and may change. A 🟡 for a leader means the feature exists in some form or we could not confirm the details.

## 📍 Roadmap

### ✅ Recently shipped

- [x] **0.9.1** The client portal no longer reads a shared project's notes, budget, team, manager and costs, a task's assignees, or a timesheet's person, note and rates. Needs platform 0.3.4.
- [x] **0.9.0** Teams and private projects work without setup, timesheet approval is a package default, team members' personal data is declared for erasure, and a customer's people read their shared projects on the portal.
- [x] **0.8.0** Project teams and private projects, statuses with categories and workflows, weekly timesheets with a timer and approval, templates, rate cards, invoices in another currency, four kinds of dependency.
- [x] **0.7.0** An approved change moves the plan, budget and contract value, the first kept as a baseline; forecast margin; capacity from a business calendar.
- [x] **0.6.0** A board and a timeline you can use by hand, a page for each task, My work and Planning.
- [x] **0.5.0** Risks, issues, change requests, resource allocations and portfolios, with workload and portfolio reports; repeating tasks.

### 🔜 Next up

**Agile and delivery**
- [ ] **Backlog and sprints**: plan, start, complete and carry over, for software and product teams.
- [ ] **Estimates in points** and a remaining estimate, with **burndown and velocity**.
- [ ] **Work-in-progress limits** on board columns.

**Project health**
- [ ] **Status updates with a health rating** and a posted note, with a weekly reminder.
- [ ] **Budget alerts** at a threshold, and a burn rate.
- [ ] **A portfolio roll-up of money, dates and health**, not only task counts.

**Reaching people**
- [ ] **Email to task** and **calendar feeds** of my tasks.
- [ ] **Slack and Teams** messages on events.
- [ ] **A mobile app** to log time and update tasks, with offline use.

**Billing**
- [ ] **Review unbilled time** before invoicing: adjust, hold, write off, group by task or person.
- [ ] **Cap on time and materials** (not to exceed) with a warning.
- [ ] **Bill expenses** with markup.
- [ ] **Retainers**: a monthly fee, prepaid hours with draw-down.

### 🔭 Later

- [ ] **More baselines**, saved on demand, per task, with variance on the timeline; Gantt print and export.
- [ ] **Workload from task estimates**, and **capacity that knows leave** from HR.
- [ ] **Utilisation**: billable hours over capacity, against a target.
- [ ] **Role-based and tentative booking**, and skills on people.
- [ ] **Earned value** (planned value, earned value, actual cost, CPI, SPI).
- [ ] **Revenue recognition** of fixed price projects by percent complete.
- [ ] **Task approvals** with a named approver and history.
- [ ] **Checklists in a task**, and **typed links between tasks** (related, duplicates).
- [ ] **Project request intake**: a form, triage, approval, then a project.
- [ ] **Programs** between portfolios and projects; **scoring and ranking** of proposed projects; **dependencies between projects**.
- [ ] **A task in several projects.**
- [ ] **Importers** from Jira, Asana, Trello and MS Project, with hierarchy and comments.
- [ ] **Git links**: branches, commits and pull requests on a task.
- [ ] **Docs and wiki** attached to a project.
- [ ] **Project-level automation rules** owned by the project manager.
- [ ] **Proofing** of images and documents.
- [ ] **Dashboards** for utilisation, budget burn, planned against actual and unbilled age.

## 🚀 Install

Projects is a native Ferrum app for platform `>=0.3.4, <0.4`.

1. In Ferrum, open the **App Manager** (or the store) and install **Projects**. The invoicing connector **Projects and ERP** is offered where ERP is installed too, and ships with Projects. Self-hosters who build their own server image include the `projects` app with the others.
2. Give roles: **Projects Manager** to the people who plan and bill, **Projects User** to everyone who works on tasks and records time, **Accounts Manager** to finance, and **Project Client** to a customer's people (list them under the customer's Client People).
3. Open **Projects Settings**: who approves timesheets, the business calendar for scheduling and capacity, the week's first day and the reminder weekday. Give people a **Project Person** record with their manager and weekly hours.
4. Add **Activity Types** with billing and costing rates and their service items, then **Rate Cards** if rates vary by project, customer or role.
5. Create a project, choose its billing method, list its team, and add tasks. Save a good plan as a template for next time.
6. Record time, submit it for approval, and use **Create Sales Invoice** on the project or the timesheet.

## 🔧 Develop

```bash
# an ordinary (non-superuser) role, so row-level security applies
createuser ferrum --pwprompt && createdb -O ferrum ferrum_projects_test

export FERRUM_PROJECTS_TEST_DATABASE_URL=postgres://ferrum:ferrum@localhost:5432/ferrum_projects_test
cargo fmt -- --check
cargo clippy --all-targets -- -D warnings
cargo test
```

The tests also build on [ferrum-app-erp](https://github.com/CBFerrum/ferrum-app-erp), which Cargo takes from GitHub. To work on both together, clone it next to this repository and patch it in `.cargo/config.toml` (git-ignored):

```toml
[patch."https://github.com/CBFerrum/ferrum-app-erp"]
ferrum-app-erp = { path = "../ferrum-app-erp" }
```

The interface lives in `ui/` and builds with Ferrum-Frontend's packages (clone Ferrum-Frontend into `ferrum/web` next to this repository, as CI does):

```bash
cd ui
npm run build       # ui/dist, checked against the size budget
npm run check
npm run typecheck
npm test
```

With a development server started with `FERRUM_DEV_UI=1`, `ferrum-app dev --ui` serves the pages from Vite behind the real bar and session, with hot reload.

`tests/` covers the rules end to end, upgrades from earlier packages (fixtures for 0.8.0 and 0.9.0) and what the portal role cannot read.

## 📂 Project layout

```text
app.yaml                      the manifest: id, version, requirements, what it adds to Ferrum
connectors/erp/app.yaml       the connector with ERP (invoicing)
packages/projects/            entities, roles, approvals, seeded statuses; sql/ upgrades older workspaces
packages/projects_erp/        invoicing fields, actions and permissions
src/                          project, task, timesheet, billing, planning, templates, schedule, status, reports, endpoints
ui/src/                       home, project (board, timeline, time), task, my work, planning; words in Arabic and Hindi
tests/                        integration tests against a real PostgreSQL, with upgrade fixtures
```

## 📜 Changelog

Recent releases are listed above; every version is in [CHANGELOG.md](CHANGELOG.md).

## 🤝 Contributing

Issues and pull requests are welcome at [github.com/CBFerrum/ferrum-app-projects](https://github.com/CBFerrum/ferrum-app-projects/issues). Please run the checks in Develop first.

## 📄 License

AGPL-3.0-only. See [LICENSE](LICENSE).

<div align="center">

<sub>Part of <a href="https://github.com/CBFerrum/Ferrum">Ferrum</a>, the open business platform · Made with 🦀 Rust and 🐘 PostgreSQL</sub>

</div>
