// Projects' own screens, at the top of each: the projects, what is on your plate, and (for people
// who plan others' time) who is booked when.

import { NavLink } from "react-router";
import { useMetaIndex } from "@ferrum/records";

/** Whether the person may see everyone's allocations, which the planning screen is about. */
export function usePlanner(): boolean {
  const meta = useMetaIndex().data?.entities.find((e) => e.name === "ResourceAllocation");
  return meta?.permissions.read === "all";
}

export function Nav() {
  const planner = usePlanner();
  return (
    <nav className="pj-tabs" aria-label="Projects">
      <NavLink to="/" end>
        Projects
      </NavLink>
      <NavLink to="/my">My work</NavLink>
      {planner && <NavLink to="/plan">Planning</NavLink>}
    </nav>
  );
}
