        # Ferrum Projects

        A native app for [Ferrum](https://github.com/CBFerrum/Ferrum), the open-source, AI-first ERP.

        - Projects with billing methods (time and materials, fixed price, non-billable), budgets and progress
- Task trees with dependencies (cycle-safe), milestones and assignees
- Activity types and per-person costs; timesheets that refuse overlapping time
- Billing: invoice unbilled time or milestones from the project; cancelling the invoice releases them
- Reports: project profitability (with ledger costs), timesheet summary, task overview

        ## Install

        Workspace administrators install it from **Apps** in Ferrum; it ships in the official Ferrum
        server image. Self-hosters building their own image enable the `projects` feature of the server.
        Everything it adds is also available to AI agents over Ferrum's MCP server.

        ## Develop

        Clone it next to the platform and point the platform dependencies at your checkout (this file
        is git-ignored):

        ```toml
        # .cargo/config.toml
        [patch."https://github.com/CBFerrum/Ferrum"]
        ferrum-kernel = { path = "../ferrum/crates/kernel" }
        ferrum-meta = { path = "../ferrum/crates/meta" }
        ferrum-domain = { path = "../ferrum/crates/domain" }
        ```

        The tests need PostgreSQL with an ordinary (non-superuser) role — row-level security must apply:

        ```bash
        createuser ferrum --pwprompt && createdb -O ferrum ferrum_projects_test
        ```

        ```bash
        cargo test
        ```

        `FERRUM_PROJECTS_TEST_DATABASE_URL` overrides the database URL. The app's metadata lives in `packages/` and is embedded
        at build time; `app.yaml` is its manifest (see Ferrum's `docs/plan/apps.md`).

        ## License

        AGPL-3.0-only, like the platform.
