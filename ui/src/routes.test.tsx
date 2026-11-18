// @vitest-environment jsdom
// The app's real route table, mounted with a server that answers what the project page asks: the timeline tab draws,
// and someone who may change the project is offered a baseline.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setFrameMode } from "@ferrum/records/frame";
import { PROJECTS_PACKAGES, routes } from "./routes";

const all = { read: "all", write: "all", create: "all", delete: "all", submit: "all", cancel: "all", export: "all", import: "all" };
const entity = (name: string) => ({ name, label: name, label_plural: `${name}s`, kind: "master", submittable: false, permissions: all });
const answers: Record<string, unknown> = {
  "/api/auth/me": { tenant: "t", user: { id: "u1", email: "asha@acme.test", full_name: "Asha Rao", is_admin: false, roles: [] }, scopes: {}, packages: ["projects"], fiscal_year_start_month: 4, default_company: null },
  "/api/meta": { version: 1, packages: [], modules: [], warnings: [], entities: [entity("Project"), entity("Task"), entity("ProjectBaseline")] },
  "/api/v1/Project/p1": { id: "p1", version: 1, project_name: "Website", status: "Open", start_date: "2026-11-02", end_date: "2026-12-20" },
  "/api/app/projects/tasks": { rows: [{ id: "1", version: 1, number: "TASK-1", subject: "Design", status: "Open", project: "p1", exp_start_date: "2026-11-02", exp_end_date: "2026-11-06", assigned_to: [], depends_on: [] }], total: 1 },
  "/api/v1/ProjectBaseline": { rows: [], total: 0 },
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  // jsdom lays nothing out: the timeline scrolls to today on opening.
  Element.prototype.scrollTo = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input instanceof Request ? input.url : input), "http://localhost").pathname;
      const body = answers[path] ?? (path.startsWith("/api/v1/") ? { rows: [], total: 0 } : undefined);
      return new Response(JSON.stringify(body ?? { error: "not found" }), { status: body === undefined ? 404 : 200, headers: { "content-type": "application/json" } });
    }),
  );
  setFrameMode("app", PROJECTS_PACKAGES);
});
afterEach(() => vi.unstubAllGlobals());

/** Mounts the app's routes at an address and waits for the server's answers to be drawn. */
async function open(path: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 40; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 25))));
  const text = host.textContent ?? "";
  await act(async () => root.unmount());
  host.remove();
  return text;
}

describe("Projects' routes as mounted", () => {
  it("opens a project's timeline and offers a baseline", async () => {
    const text = await open("/p/p1?tab=timeline");
    expect(text).toContain("Design");
    expect(text).toContain("Set a baseline");
  });
});
