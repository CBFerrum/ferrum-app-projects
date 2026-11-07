// Projects' own screens, at the top of each: the projects, what is on your plate, and (for people
// who plan others' time) who is booked when.

import { NavLink } from "react-router";
import { useMetaIndex } from "@ferrum/records";
import { t } from "@ferrum/client";

/** Whether the person may see everyone's allocations, which the planning screen is about. */
export function usePlanner(): boolean {
  const meta = useMetaIndex().data?.entities.find((e) => e.name === "ResourceAllocation");
  return meta?.permissions.read === "all";
}

export function Nav() {
  const planner = usePlanner();
  return (
    <nav className="pj-tabs" aria-label={t("Projects")}>
      <NavLink to="/" end>
        {t("Projects")}
      </NavLink>
      <NavLink to="/my">{t("My work")}</NavLink>
      {planner && <NavLink to="/plan">{t("Planning")}</NavLink>}
    </nav>
  );
}
