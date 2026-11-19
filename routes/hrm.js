/*
  HRM routes. Mounted once from routes/index.js:
    /hrm      -> server-rendered HRM interface
    /api/hrm  -> read-only JSON API for other RektaBuild modules (HR role required)
*/
import express from "express";
import {
  hrmContext,
  requireAccess,
  requireHR,
  requireAdmin,
  csrfCheck,
} from "../middleware/hrmAuth.js";
import { Op } from "sequelize";
import { apiKeyOrSession } from "../middleware/apiKeyAuth.js";
import {
  Department,
  Position,
  Employee,
  LeaveType,
  LeaveBalance,
  LeaveRequest,
  Attendance,
  WorkSchedule,
  Assignment,
} from "../models/hrm/index.js";
import { registerHelpers } from "../controllers/hrm/_shared.js";
import * as dashboard from "../controllers/hrm/dashboardController.js";
import * as employees from "../controllers/hrm/employeeController.js";
import * as attendance from "../controllers/hrm/attendanceController.js";
import * as leave from "../controllers/hrm/leaveController.js";
import * as organization from "../controllers/hrm/orgController.js";
import * as assignments from "../controllers/hrm/assignmentController.js";
import * as reports from "../controllers/hrm/reportController.js";
import * as users from "../controllers/hrm/userController.js";
import * as svc from "../models/hrm/services/hrmService.js";

registerHelpers();
const routes = express.Router();
routes.use(hrmContext, requireAccess, csrfCheck);

// Reject non-numeric ids early (e.g. /hrm/employees/abc) instead of hitting the database
const numeric = (req, res, next, v) =>
  /^\d+$/.test(v)
    ? next()
    : res.status(404).render("hrm/403", { title: "Not found", active: "" });
routes.param("id", numeric);
routes.param("docId", numeric);

routes.get("/", dashboard.index);
routes.get("/me", employees.me);
routes.get("/me/password", employees.changePasswordForm);
routes.post("/me/password", employees.changePassword);

// Employees (HR) + own profile / documents
routes.get("/employees", requireHR, employees.index);
routes.get("/employees/new", requireHR, employees.newForm);
routes.post("/employees", requireHR, employees.create);
routes.get("/employees/:id", employees.show);
routes.get("/employees/:id/edit", requireHR, employees.editForm);
routes.post("/employees/:id", requireHR, employees.update);
routes.post("/employees/:id/deactivate", requireHR, employees.deactivate);
routes.post("/employees/:id/reactivate", requireHR, employees.reactivate);
routes.post("/employees/:id/resignation", employees.submitResignation);
routes.post("/employees/:id/resignation/cancel", employees.cancelResignation);
routes.post("/employees/:id/documents", requireHR, employees.uploadDoc, employees.addDocument);
routes.get("/documents/:docId/download", employees.downloadDocument);
routes.post("/documents/:docId/delete", requireHR, employees.deleteDocument);

// Attendance
routes.get("/attendance", attendance.index);
routes.get("/attendance/calendar", attendance.calendar);
routes.post("/attendance/time-in", attendance.timeIn);
routes.post("/attendance/time-out", attendance.timeOut);
routes.post("/attendance/save", requireHR, attendance.save);
routes.post("/attendance/generate-absences", requireHR, attendance.generateAbsences);
routes.post("/attendance/:id/delete", requireHR, attendance.remove);

// Leave
routes.get("/leave", leave.index);
routes.post("/leave", leave.apply);
routes.get("/leave/balances", leave.balances);
routes.post("/leave/balances/:id", requireHR, leave.updateBalance);
routes.get("/leave/types", requireHR, leave.typesIndex);
routes.post("/leave/types", requireHR, leave.typeCreate);
routes.post("/leave/types/:id", requireHR, leave.typeUpdate);
routes.post("/leave/types/:id/delete", requireHR, leave.typeDelete);
routes.post("/leave/:id/approve", requireHR, leave.approve);
routes.post("/leave/:id/reject", requireHR, leave.reject);
routes.post("/leave/:id/cancel", leave.cancel);

// Departments & positions
routes.get("/departments", requireHR, organization.deptIndex);
routes.post("/departments", requireHR, organization.deptCreate);
routes.post("/departments/:id", requireHR, organization.deptUpdate);
routes.post("/departments/:id/delete", requireHR, organization.deptDelete);
routes.get("/positions", requireHR, organization.posIndex);
routes.post("/positions", requireHR, organization.posCreate);
routes.post("/positions/:id", requireHR, organization.posUpdate);
routes.post("/positions/:id/delete", requireHR, organization.posDelete);

// Assignments & schedules
routes.get("/assignments", requireHR, assignments.index);
routes.post("/assignments", requireHR, assignments.create);
routes.post("/assignments/:id", requireHR, assignments.update);
routes.post("/assignments/:id/end", requireHR, assignments.end);
routes.post("/assignments/:id/delete", requireHR, assignments.remove);
routes.get("/schedules", requireHR, assignments.schedules);
routes.post("/schedules", requireHR, assignments.saveSchedule);

routes.get("/reports", requireHR, reports.index);

// Resignations & user accounts (admin only)
routes.get("/resignations", requireAdmin, employees.resignationIndex);
routes.post("/resignations/:id/approve", requireAdmin, employees.approveResignation);
routes.post("/resignations/:id/reject", requireAdmin, employees.rejectResignation);
routes.get("/users", requireAdmin, users.index);
routes.post("/users/:id/role", requireAdmin, users.updateRole);

// Error page (keeps layout)
routes.use((err, req, res, next) => {
  console.error("HRM error:", err);
  res.status(500).render("hrm/error", {
    title: "Something went wrong",
    active: "",
    message: err.message,
  });
});

// ---- Read-only API for other RektaBuild modules ----
// Auth: X-API-Key header (HRM_API_KEY) or an HR browser session.
const api = express.Router();
api.use(apiKeyOrSession);
const j = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (e) {
    res
      .status(e instanceof svc.HrmError ? 400 : 500)
      .json({ error: e.message });
  }
};
const intParam = (v) => (/^\d+$/.test(String(v || "")) ? Number(v) : null);
const dateParam = (v) =>
  /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null;
const pageLimit = (v, dflt = 500, max = 1000) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : dflt;
};
// Records whose [startDate, endDate] period overlaps the given range.
// A null endDate means "still ongoing" and always overlaps the `from` side.
const periodOverlap = (from, to) => {
  const conds = [];
  if (from)
    conds.push({
      [Op.or]: [{ endDate: null }, { endDate: { [Op.gte]: from } }],
    });
  if (to) conds.push({ startDate: { [Op.lte]: to } });
  return conds.length ? { [Op.and]: conds } : {};
};
const empBrief = {
  model: Employee,
  as: "employee",
  attributes: [
    "id",
    "employeeNo",
    "firstName",
    "middleName",
    "lastName",
    "suffix",
    "employmentStatus",
    "isActive",
    "hireDate",
    "departmentId",
    "positionId",
    "resignationDate",
    "resignationStatus",
  ],
  include: [
    { model: Department, as: "department", attributes: ["id", "name", "code"] },
    { model: Position, as: "position", attributes: ["id", "title"] },
  ],
};
const deptPosInclude = empBrief.include;

// ---- People ----
api.get(
  "/employees",
  j((r) =>
    svc.listActiveEmployees({
      departmentId: intParam(r.query.departmentId),
      includeInactive: r.query.includeInactive === "true",
    }),
  ),
);
api.get("/employees/:id", async (req, res) => {
  const e = await svc.getEmployee(req.params.id);
  e ? res.json(e) : res.status(404).json({ error: "Not found" });
});
api.get(
  "/departments",
  j(() =>
    Department.findAll({
      attributes: ["id", "name", "code", "description", "isActive"],
      include: [
        {
          model: Position,
          as: "positions",
          attributes: ["id", "title", "isActive"],
        },
      ],
      order: [["name", "ASC"]],
    }),
  ),
);
api.get(
  "/positions",
  j(() =>
    Position.findAll({
      attributes: ["id", "title", "description", "isActive", "departmentId"],
      include: [
        {
          model: Department,
          as: "department",
          attributes: ["id", "name", "code"],
        },
      ],
      order: [["title", "ASC"]],
    }),
  ),
);
api.get(
  "/headcount",
  j(() => svc.getHeadcountByDepartment()),
);
api.get(
  "/resignations",
  j((r) => {
    const where = { resignationStatus: { [Op.ne]: null } };
    if (r.query.status) where.resignationStatus = String(r.query.status);
    const employeeId = intParam(r.query.employeeId);
    if (employeeId) where.id = employeeId;
    return Employee.findAll({
      where,
      include: deptPosInclude,
      order: [
        [
          Employee.sequelize.literal(
            "FIELD(HrmEmployee.resignationStatus,'pending','rejected','approved')",
          ),
          "ASC",
        ],
        ["resignationReviewedAt", "DESC"],
      ],
      limit: pageLimit(r.query.limit, 200, 500),
    });
  }),
);

// ---- Projects & assignments ----
api.get(
  "/projects",
  j(() => svc.listProjectReferences()),
);
api.get(
  "/projects/:key/employees",
  j((r) => svc.getEmployeesByProject(r.params.key)),
);
api.get(
  "/assignments",
  j((r) => {
    const where = {};
    const employeeId = intParam(r.query.employeeId);
    const projectId = intParam(r.query.projectId);
    if (employeeId) where.employeeId = employeeId;
    if (projectId) where.projectId = projectId;
    if (r.query.projectName) where.projectName = String(r.query.projectName);
    if (r.query.status) where.status = String(r.query.status);
    Object.assign(
      where,
      periodOverlap(dateParam(r.query.from), dateParam(r.query.to)),
    );
    return Assignment.findAll({
      where,
      include: [empBrief],
      order: [["startDate", "DESC"], ["id", "DESC"]],
      limit: pageLimit(r.query.limit),
    });
  }),
);

// ---- Time & attendance ----
api.get("/attendance",
  j((r) => {
    const where = {};
    const employeeId = intParam(r.query.employeeId);
    if (employeeId) where.employeeId = employeeId;
    const from = dateParam(r.query.from);
    const to = dateParam(r.query.to);
    if (from && to) where.date = { [Op.between]: [from, to] };
    else if (from) where.date = { [Op.gte]: from };
    else if (to) where.date = { [Op.lte]: to };
    if (r.query.status) where.status = String(r.query.status);
    return Attendance.findAll({
      where,
      include: [empBrief],
      order: [["date", "DESC"], ["id", "DESC"]],
      limit: pageLimit(r.query.limit),
    });
  }),
);
api.get(
  "/attendance-summary",
  j((r) =>
    svc.getAttendanceSummary(r.query.employeeId, r.query.from, r.query.to),
  ),
);
api.get(
  "/schedules",
  j((r) => {
    const where = {};
    const employeeId = intParam(r.query.employeeId);
    if (employeeId) where.employeeId = employeeId;
    const from = dateParam(r.query.from);
    const to = dateParam(r.query.to);
    const conds = [];
    if (to) conds.push({ effectiveFrom: { [Op.lte]: to } });
    if (from)
      conds.push({
        [Op.or]: [{ effectiveTo: null }, { effectiveTo: { [Op.gte]: from } }],
      });
    if (conds.length) where[Op.and] = conds;
    return WorkSchedule.findAll({
      where,
      include: [empBrief],
      order: [["effectiveFrom", "DESC"]],
      limit: pageLimit(r.query.limit),
    });
  }),
);
// ---- Leave ----
api.get("/leave-types", j(() => LeaveType.findAll({ order: [["name", "ASC"]] })));
api.get(
  "/leave-requests",
  j((r) => {
    const where = {};
    const employeeId = intParam(r.query.employeeId);
    const leaveTypeId = intParam(r.query.leaveTypeId);
    if (employeeId) where.employeeId = employeeId;
    if (leaveTypeId) where.leaveTypeId = leaveTypeId;
    if (r.query.status) where.status = String(r.query.status);
    Object.assign(
      where,
      periodOverlap(dateParam(r.query.from), dateParam(r.query.to)),
    );
    const year = intParam(r.query.year);
    if (year && !r.query.from && !r.query.to)
      where.startDate = { [Op.between]: [`${year}-01-01`, `${year}-12-31`] };
    return LeaveRequest.findAll({
      where,
      include: [
        empBrief,
        {
          model: LeaveType,
          as: "leaveType",
          attributes: ["id", "name", "isPaid"],
        },
      ],
      order: [["startDate", "DESC"], ["id", "DESC"]],
      limit: pageLimit(r.query.limit),
    });
  }),
);
api.get(
  "/leave-balances",
  j(async (r) => {
    const year = intParam(r.query.year) || new Date().getFullYear();
    const employeeId = intParam(r.query.employeeId);
    await svc.ensureBalances(year, employeeId ? [employeeId] : null);
    const where = { year };
    const leaveTypeId = intParam(r.query.leaveTypeId);
    const departmentId = intParam(r.query.departmentId);
    if (employeeId) where.employeeId = employeeId;
    if (leaveTypeId) where.leaveTypeId = leaveTypeId;
    const rows = await LeaveBalance.findAll({
      where,
      include: [
        {
          model: LeaveType,
          as: "leaveType",
          attributes: ["id", "name", "isPaid"],
        },
        {
          model: Employee,
          as: "employee",
          attributes: [
            "id",
            "employeeNo",
            "firstName",
            "middleName",
            "lastName",
            "suffix",
            "isActive",
          ],
          ...(departmentId ? { where: { departmentId } } : {}),
        },
      ],
      order: [["id", "ASC"]],
      limit: pageLimit(r.query.limit, 2000, 5000),
    });
    return rows.map((b) => {
      const p = b.get({ plain: true });
      return { ...p, remaining: Number(p.entitled) - Number(p.used) };
    });
  }),
);

// ---- Payroll ----
api.get(
  "/payroll-inputs",
  j((r) =>
    svc.getPayrollInputs(r.query.from, r.query.to, {
      departmentId: r.query.departmentId,
    }),
  ),
);

const router = express.Router();
router.use("/hrm", routes);
router.use("/api/hrm", api);
export default router;
