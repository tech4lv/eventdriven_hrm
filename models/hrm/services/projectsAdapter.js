/*
  Swap point for construction projects. No module owns a "projects" table yet, so HRM
  stores projectName/siteName (and an optional projectId) on each assignment.
  When the owning module exists, replace listProjects() with a call into it.
*/
import { Assignment, sequelize } from "../index.js";
import { normLabel } from "./hrmUtils.js";

const distinctValues = (rows, field) => {
  const seen = new Map();
  for (const r of rows) {
    const v = normLabel(r[field]);
    if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
};

export async function listProjects() {
  const rows = await Assignment.findAll({
    attributes: ["projectName"],
    raw: true,
  });
  return distinctValues(rows, "projectName");
}
export async function listSites() {
  const rows = await Assignment.findAll({
    attributes: ["siteName"],
    where: { siteName: { [sequelize.Sequelize.Op.ne]: null } },
    raw: true,
  });
  return distinctValues(rows, "siteName");
}
