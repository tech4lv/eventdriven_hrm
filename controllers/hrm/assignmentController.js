import { Op, fn, col } from "sequelize";
import { Department, Employee, Assignment } from "../../models/hrm/index.js";
import {
  HrmError,
  todayStr,
  isDate,
  normLabel,
} from "../../models/hrm/services/hrmUtils.js";
import {
  getScheduleMap,
  hrmEvents,
  saveWorkSchedule,
} from "../../models/hrm/services/hrmService.js";
import {
  listProjects,
  listSites,
} from "../../models/hrm/services/projectsAdapter.js";
import { safe, back, plain, intOrNull } from "./_shared.js";

export const index = safe(async (req, res) => {
  const { q = "", status = "active", employeeId = "" } = req.query;
  const where = {};
  if (status) where.status = status;
  if (employeeId) where.employeeId = employeeId;
  if (q.trim())
    where[Op.or] = [
      { projectName: { [Op.like]: `%${q.trim()}%` } },
      { siteName: { [Op.like]: `%${q.trim()}%` } },
    ];
  const [rows, byProject, emps, projects, sites] = await Promise.all([
    Assignment.findAll({
      where,
      include: [
        {
          model: Employee,
          as: "employee",
          include: [{ model: Department, as: "department" }],
        },
      ],
      order: [
        ["projectName", "ASC"],
        ["startDate", "DESC"],
      ],
    }),
    Assignment.findAll({
      where: { status: "active" },
      attributes: [
        "projectName",
        "siteName",
        [fn("COUNT", col("id")), "workers"],
      ],
      group: ["projectName", "siteName"],
      order: [["projectName", "ASC"]],
      raw: true,
    }),
    Employee.findAll({
      where: { isActive: true },
      order: [["lastName", "ASC"]],
    }),
    listProjects(),
    listSites(),
  ]);
  res.render("hrm/assignments/index", {
    title: "Project Assignments",
    active: "assignments",
    rows: plain(rows),
    byProject,
    employees: plain(emps),
    projects,
    sites,
    q,
    status,
    employeeId,
    today: todayStr(),
  });
});

const fields = async (b) => {
  const projectName = normLabel(b.projectName);
  const siteName = normLabel(b.siteName);
  const roleOnProject = normLabel(b.roleOnProject);
  const notes = normLabel(b.notes);
  if (!projectName) throw new HrmError("Project name is required.");
  if (projectName.length > 150)
    throw new HrmError("Project name must be 150 characters or fewer.");
  if (siteName && siteName.length > 150)
    throw new HrmError("Site name must be 150 characters or fewer.");
  if (roleOnProject && roleOnProject.length > 100)
    throw new HrmError("Role must be 100 characters or fewer.");
  if (notes && notes.length > 255)
    throw new HrmError("Notes must be 255 characters or fewer.");
  const d = {
    projectName,
    siteName,
    roleOnProject,
    startDate: b.startDate,
    endDate: b.endDate || null,
    notes,
    status: b.status,
  };
  d.projectId = intOrNull(b.projectId);
  if (!isDate(d.startDate)) throw new HrmError("Start date is required.");
  if (d.endDate && (!isDate(d.endDate) || d.endDate < d.startDate))
    throw new HrmError("End date cannot be before the start date.");
  if (!["active", "completed", "cancelled"].includes(d.status))
    d.status = "active";
  return d;
};

const sameProjectRef = (a, d) => {
  const name = (normLabel(a.projectName) || "").toLowerCase();
  const dName = (normLabel(d.projectName) || "").toLowerCase();
  const site = (normLabel(a.siteName) || "").toLowerCase();
  const dSite = (normLabel(d.siteName) || "").toLowerCase();
  const sameProject =
    a.projectId && d.projectId ? a.projectId === d.projectId : name === dName;
  return sameProject && site === dSite;
};

async function assertNoDuplicateActive(employeeId, d, excludeId = null) {
  const active = await Assignment.findAll({
    where: {
      employeeId,
      status: "active",
      ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}),
    },
  });
  if (active.some((a) => sameProjectRef(a, d)))
    throw new HrmError(
      "This employee already has an active assignment for this project reference.",
    );
}
export const create = safe(async (req, res) => {
  const emp = await Employee.findByPk(req.body.employeeId);
  if (!emp || !emp.isActive) throw new HrmError("Select an active employee.");
  const d = await fields(req.body);
  await assertNoDuplicateActive(emp.id, d);
  const a = await Assignment.create({ ...d, employeeId: emp.id });
  hrmEvents.emit("assignment.changed", {
    id: a.id,
    employeeId: emp.id,
    projectName: a.projectName,
    status: a.status,
  });
  req.flash("success_msg", `${emp.fullName} assigned to ${a.projectName}.`);
  res.redirect(back(req, "/hrm/assignments"));
});
export const update = safe(async (req, res) => {
  const a = await Assignment.findByPk(req.params.id);
  if (!a) return res.redirect("/hrm/assignments");
  const d = await fields(req.body);
  await assertNoDuplicateActive(a.employeeId, d, a.id);
  await a.update(d);
  hrmEvents.emit("assignment.changed", {
    id: a.id,
    employeeId: a.employeeId,
    projectName: a.projectName,
    status: a.status,
  });
  req.flash("success_msg", "Assignment updated.");
  res.redirect(back(req, "/hrm/assignments"));
});
export const end = safe(async (req, res) => {
  const a = await Assignment.findByPk(req.params.id);
  if (a) {
    await a.update({ status: "completed", endDate: todayStr() });
    hrmEvents.emit("assignment.changed", {
      id: a.id,
      employeeId: a.employeeId,
      status: "completed",
    });
  }
  req.flash("success_msg", "Assignment ended.");
  res.redirect(back(req, "/hrm/assignments"));
});
export const remove = safe(async (req, res) => {
  await Assignment.destroy({ where: { id: req.params.id } });
  req.flash("success_msg", "Assignment deleted.");
  res.redirect(back(req, "/hrm/assignments"));
});

// ---- Work schedules ----
export const schedules = safe(async (req, res) => {
  const { q = "", departmentId = "" } = req.query;
  const where = { isActive: true };
  if (departmentId) where.departmentId = departmentId;
  if (q.trim())
    where[Op.or] = ["firstName", "lastName", "employeeNo"].map((f) => ({
      [f]: { [Op.like]: `%${q.trim()}%` },
    }));
  const emps = await Employee.findAll({
    where,
    include: [{ model: Department, as: "department" }],
    order: [["lastName", "ASC"]],
  });
  const map = await getScheduleMap(
    todayStr(),
    emps.map((e) => e.id),
  );
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const rows = plain(emps).map((e) => {
    const s = map.get(e.id);
    return {
      employee: e,
      custom: !!s,
      workDays: s?.workDays || "1,2,3,4,5,6",
      shiftStart: s?.shiftStart || "08:00:00",
      shiftEnd: s?.shiftEnd || "17:00:00",
      effectiveFrom: s?.effectiveFrom || null,
      daysLabel: (s?.workDays || "1,2,3,4,5,6")
        .split(",")
        .map((d) => names[d])
        .join(" · "),
    };
  });
  res.render("hrm/schedules/index", {
    title: "Work Schedules",
    active: "schedules",
    rows,
    q,
    departmentId,
    today: todayStr(),
    departments: plain(await Department.findAll({ order: [["name", "ASC"]] })),
  });
});
export const saveSchedule = safe(async (req, res) => {
  const b = req.body;
  const emp = await Employee.findByPk(b.employeeId);
  if (!emp) throw new HrmError("Employee not found.");
  await saveWorkSchedule({
    employeeId: emp.id,
    workDays: b.workDays,
    shiftStart: b.shiftStart,
    shiftEnd: b.shiftEnd,
    effectiveFrom: b.effectiveFrom,
  });
  req.flash("success_msg", `Schedule saved for ${emp.fullName}.`);
  res.redirect(back(req, "/hrm/schedules"));
});
