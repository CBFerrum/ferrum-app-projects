// Projects' own interface (Ferrum docs/plan/apps-ui.md §13, U5) at /projects/: the open projects on
// its home; each project's board, timeline and time at /p/{id}; a task, whole, at /t/{id}; what is on
// someone's plate at /my; who is booked when and how the portfolios stand at /plan; and the rest of
// its records (timesheets, risks, activity types and costs) as lists and forms in the records frame,
// with its modules in the sidebar under the platform's bar. Each screen loads when first opened.

import { mountApp, setFrameMode } from "@ferrum/records/frame";
import { PROJECTS_PACKAGES, routes } from "./routes";
import "./styles.css";

setFrameMode("app", PROJECTS_PACKAGES);

mountApp({
  route: "projects",
  catalogs: { ar: () => import("./locales/ar.json"), hi: () => import("./locales/hi.json") },
  routes,
});
