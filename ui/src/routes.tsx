// Projects' route table, apart from the page that mounts it so a test can mount the real thing.

import { useEffect } from "react";
import { Link, type RouteObject, useRouteError } from "react-router";
import { shell, t } from "@ferrum/client";
import { EmptyState, ErrorState } from "@ferrum/kit";
import { RequireAuth } from "@ferrum/records/frame";
import { ProjectsHome } from "./Home";

/** A page of the records frame, loaded when first opened. */
const page = (name: "FormView" | "ListView" | "ReportView") => () =>
  import("./records").then((m) => ({ Component: m[name] }));

/** Projects' packages (and the shared projects): the sidebar shows their modules. */
export const PROJECTS_PACKAGES = ["projects", "projects_erp", "project_records"];

function RouteError() {
  return <ErrorState error={useRouteError()} onRetry={() => window.location.reload()} />;
}

function NotFound() {
  return (
    <EmptyState title={t("Page not found")}>
      <Link to="/">{t("Go to the projects")}</Link>
    </EmptyState>
  );
}

/** Every page tells the shell it started. */
function Started() {
  useEffect(() => shell().ready(), []);
  return null;
}

export const routes: RouteObject[] = [
  {
    path: "/",
    element: (
      <>
        <Started />
        <RequireAuth />
      </>
    ),
    errorElement: <RouteError />,
    children: [
      { index: true, element: <ProjectsHome /> },
      { path: "p/:id", lazy: () => import("./Project").then((m) => ({ Component: m.ProjectPage })) },
      { path: "t/:id", lazy: () => import("./Task").then((m) => ({ Component: m.TaskRoute })) },
      { path: "my", lazy: () => import("./MyWork").then((m) => ({ Component: m.MyWork })) },
      { path: "plan", lazy: () => import("./Planning").then((m) => ({ Component: m.Planning })) },
      { path: "e/:entity", lazy: page("ListView") },
      { path: "e/:entity/:id", lazy: page("FormView") },
      { path: "r/:name", lazy: page("ReportView") },
      { path: "*", element: <NotFound /> },
    ],
  },
];
