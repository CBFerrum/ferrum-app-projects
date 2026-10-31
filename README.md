<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
  <img alt="Ferrum Projects" src="docs/assets/banner-light.svg" width="100%">
</picture>

[![CI](https://github.com/CBFerrum/ferrum-app-projects/actions/workflows/ci.yml/badge.svg)](https://github.com/CBFerrum/ferrum-app-projects/actions/workflows/ci.yml) ![Version](https://img.shields.io/badge/version-0.4.1-b45309?style=flat-square) ![Ferrum](https://img.shields.io/badge/Ferrum-%3E%3D0.3.2%2C%20%3C0.4-2f5bea?style=flat-square) ![License](https://img.shields.io/badge/license-AGPL--3.0-3b82f6?style=flat-square) ![Rust](https://img.shields.io/badge/Rust-native%20app-b7410e?style=flat-square&logo=rust&logoColor=white) ![Interface](https://img.shields.io/badge/interface-React%20%2B%20Vite-0ea5e9?style=flat-square&logo=react&logoColor=white) ![MCP](https://img.shields.io/badge/AI%20agents-MCP-8b5cf6?style=flat-square)

**A native app for [Ferrum](https://github.com/CBFerrum/Ferrum), the open-source, AI-first business platform.**

[Overview](#overview) · [Highlights](#highlights) · [Screenshots](#screenshots) · [How it works](#how-it-works) · [Data model](#data-model) · [Install](#install) · [Develop](#develop) · [Changelog](#changelog)

</div>

---

## Overview

Ferrum Projects plans and bills work. Projects carry a billing method, a budget and progress;
tasks nest with cycle-safe dependencies and milestones; timesheets refuse overlapping time; and
unbilled time or milestones become invoices from the project, released again if the invoice is
cancelled. Profitability reads costs straight from the ledger.


| At a glance | |
|---|---|
| 📦 Version | `0.4.1` |
| 🧱 Platform | Ferrum `>=0.3.2, <0.4` |
| 🔗 Requires | nothing else |
| 🖥️ Interface | its own, at `/projects/` |
| 🗃️ Records | 7 entities in 2 packages |
| 👥 Roles | 4: Projects Manager, Projects User, Accounts Manager, Projects Manager |
| 📊 Reports | 3 |
| 🧪 Tests | 8 Rust tests, 1 interface test file |


## Highlights

<table>
<tr>
<td width="50%" valign="top">

### 🗂️ Projects that know how they bill
Time and materials, fixed price or non-billable, with budgets and progress.

</td>
<td width="50%" valign="top">

### 🌳 Task trees
Dependencies (cycle-safe), milestones and assignees.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### ⏱️ Honest timesheets
Activity types and per-person costs; overlapping time is refused.

</td>
<td width="50%" valign="top">

### 🧾 Billing from the project
Invoice unbilled time or milestones; cancelling the invoice releases them.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 💹 Profitability
Project profitability with ledger costs, a timesheet summary and a task overview.

</td>
<td width="50%" valign="top">

### 🤝 A shared record
Projects are a platform record other apps link to: Helpdesk, Field Service and CRM.

</td>
</tr>
</table>

## Screenshots

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/projects-dark.webp">
  <img alt="Projects with their progress, customers and dates." src="docs/assets/projects-light.webp" width="100%">
</picture>

<p align="center"><sub>Projects with their progress, customers and dates.</sub></p>

> [!TIP]
> The screenshots follow your GitHub theme: switch between light and dark to see both.

## How it works

### Time to invoice

```mermaid
flowchart LR
    T["✅ Task"] --> TS["⏱️ Timesheet<br/><small>no overlapping time</small>"]
    TS -->|unbilled time| INV["🧾 Sales invoice"]
    M["🏁 Milestone"] -->|reached| INV
    INV -->|cancelled| R["↩️ Time and milestones released"]
    TS --> P["💹 Profitability<br/><small>costs from the ledger</small>"]
    classDef app fill:#b45309,color:#fff,stroke:#b45309
    class T,TS,M app
```

### Inside Ferrum

```mermaid
flowchart LR
    subgraph Browser
        UI["Its interface<br/><small>/projects/</small>"]
        BAR["Ferrum bar<br/><small>launcher · search · bell</small>"]
    end
    subgraph Server["Ferrum server"]
        API["REST · MCP · live"]
        K["Kernel<br/><small>permissions · row-level security · audit</small>"]
        APP["Projects<br/><small>7 entities · 4 roles</small>"]
        OB[("Outbox")]
    end
    DB[("PostgreSQL")]
    UI --> API --> K --> DB
    BAR --> API
    K <--> APP
    K --> OB --> EV["Notifications · webhooks<br/>automations"]

    classDef app fill:#b45309,color:#fff,stroke:#b45309
    class APP app
```

Everything Projects adds is ordinary Ferrum metadata and Rust: its records get lists, forms,
search, permissions, an audit trail, exports and the REST and MCP APIs for free, so AI agents work
with them under the same rules as people.

### What it adds to Ferrum

| Where | What |
|---|---|
| 🚀 Launcher | **Projects** at `/projects/` |
| ➕ Create menu | Task |
| ➕ Create menu | Project |
| 🔔 Notification | Tasks assigned to you |
| ✅ My work | Your tasks |

## Data model

The main records and how they connect (7 entities in all; `packages/` has every field).

```mermaid
erDiagram
    Task {
        string subject PK
        string status
    }
    Timesheet {
        string user PK
        string status
    }
    ActivityType {
        string activity_type PK
    }
    ActivityCost {
        string user PK
    }
    Project ||--o{ Task : "project"
    Project ||--o{ Timesheet : "project"
    Timesheet ||--|{ TimesheetDetail : "time_logs"
    ActivityType ||--o{ ActivityCost : "activity_type"
```

### Roles

| Role | What it is for | Entities |
|---|---|---|
| **Projects Manager** | Plans projects and tasks, sees costs, and bills customers for time and milestones. | 11 |
| **Projects User** | Records own time and works on the tasks assigned to them. | 6 |
| **Accounts Manager** |  | 5 |
| **Projects Manager** |  | 4 |

<details>
<summary><b>Reports (3)</b></summary>

- Project Profitability
- Timesheet Summary
- Task Overview

</details>

## Install

Workspace administrators install it from **Apps** (`/store/`) in Ferrum; it ships in the
official Ferrum server image. Self-hosters building their own image enable the
`projects` feature of the server. Everything it adds is also available to AI agents over
Ferrum's MCP server, within each person's permissions.

## Develop

Clone it next to the platform:

```text
work/
├── ferrum/            https://github.com/CBFerrum/Ferrum (with Ferrum-Frontend cloned into ferrum/web)
└── ferrum-app-projects/
```

Point the platform dependencies at your checkout (this file is git-ignored):

```toml
# .cargo/config.toml
[patch."https://github.com/CBFerrum/Ferrum"]
ferrum-apps = { path = "../ferrum/crates/apps" }
ferrum-domain = { path = "../ferrum/crates/domain" }
ferrum-kernel = { path = "../ferrum/crates/kernel" }
ferrum-meta = { path = "../ferrum/crates/meta" }
```

The tests need PostgreSQL with an ordinary (non-superuser) role, so row-level security
applies:

```bash
createuser ferrum --pwprompt && createdb -O ferrum ferrum_projects_test
cargo test
```

`FERRUM_PROJECTS_TEST_DATABASE_URL` overrides the database URL.


Its tests also build on [ferrum-app-erp](https://github.com/CBFerrum/ferrum-app-erp), which Cargo takes from GitHub.
To work on it alongside this app, clone it into the same folder and add to the same file:

```toml
[patch."https://github.com/CBFerrum/ferrum-app-erp"]
ferrum-app-erp = { path = "../ferrum-app-erp" }
```


The interface lives in `ui/` and builds with Ferrum-Frontend's packages:

```bash
cd ui
npm run build      # ui/dist, checked against the size budget
npm test
```

With a development server started with `FERRUM_DEV_UI=1`, `ferrum-app dev --ui` serves the pages
from Vite behind the real bar and session, with hot reload.


### Project layout

```text
app.yaml      the manifest: id, version, requirements, what it adds to Ferrum
packages/     metadata: entities, roles, reports, workflows, print formats
src/          the app's logic in Rust: hooks, actions, endpoints, upkeep jobs
ui/           its own interface (React + Vite), built into ui/dist
tests/        integration tests against a real PostgreSQL
CHANGELOG.md  what changed in each version
```

## Changelog

| Version | Highlights |
|---|---|
| **0.4.1** | The interface starts faster: its first download holds the frame and the app's own pages, and lists, forms, reports and other apps' screens load … |
| **0.4.0** | Home's My work lists your open tasks (`/api/app/projects/work`, Ferrum docs/plan/apps-ui.md §12.8), due on their expected end, High and Urgent … |
| **0.3.2** | Rebuilt with Ferrum-Frontend a8d4dda: under the platform's bar the records frame no longer shows a second bell (the bar has notifications). |
| **0.3.1** | Someone added to a task's assignees is notified (kind `projects.assigned`, "Tasks assigned to you"), in the bar and by email unless they chose … |

Every version is in [CHANGELOG.md](CHANGELOG.md).

## License

[AGPL-3.0-only](LICENSE), like the platform. Part of [Ferrum](https://github.com/CBFerrum/Ferrum) ·
[Report an issue](https://github.com/CBFerrum/ferrum-app-projects/issues)
