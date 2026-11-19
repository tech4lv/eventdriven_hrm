import { Op } from "sequelize";
import {
  Department,
  Employee,
  LeaveType,
  LeaveBalance,
  LeaveRequest,
  User,
} from "../../models/hrm/index.js";
import { HrmError, todayStr } from "../../models/hrm/services/hrmUtils.js";
import {
  applyLeave,
  approveLeave,
  rejectLeave,
  cancelLeave,
  ensureBalances,
} from "../../models/hrm/services/hrmService.js";
import { safe, back, plain, pick, bool } from "./_shared.js";

export const index = safe(async (req, res) => {
  const {
    status = "",
    leaveTypeId = "",
    employeeId = "",
    year = String(new Date().getFullYear()),
  } = req.query;
  const where = {
    startDate: { [Op.between]: [`${year}-01-01`, `${year}-12-31`] },
  };
  if (status) where.status = status;
  if (leaveTypeId) where.leaveTypeId = leaveTypeId;
  if (req.hrm.isHR && employeeId) where.employeeId = employeeId;
  if (!req.hrm.isHR) where.employeeId = req.hrm.employee.id;
  const [rows, types, emps, pending] = await Promise.all([
    LeaveRequest.findAll({
      where,
      order: [
        [
          LeaveRequest.sequelize.literal(
            "FIELD(HrmLeaveRequest.status,'pending','approved','rejected','cancelled')",
          ),
        ],
        ["startDate", "DESC"],
      ],
      include: [
        {
          model: Employee,
          as: "employee",
          include: [{ model: Department, as: "department" }],
        },
        { model: LeaveType, as: "leaveType" },
        { model: User, as: "reviewer", attributes: ["name"] },
      ],
    }),
    LeaveType.findAll({ where: { isActive: true }, order: [["name", "ASC"]] }),
    req.hrm.isHR
      ? Employee.findAll({
          where: { isActive: true },
          order: [["lastName", "ASC"]],
        })
      : [],
    LeaveRequest.count({
      where: {
        status: "pending",
        ...(req.hrm.isHR ? {} : { employeeId: req.hrm.employee.id }),
      },
    }),
  ]);
  res.render("hrm/leave/index", {
    title: "Leave Management",
    active: "leave",
    rows: plain(rows).map((r) => ({
      ...r,
      canCancel:
        (r.status === "pending" &&
          (req.hrm.isHR || r.employeeId === req.hrm.employee?.id)) ||
        (req.hrm.isHR && r.status === "approved" && r.startDate > todayStr()),
    })),
    types: plain(types),
    employees: plain(emps),
    pending,
    status,
    leaveTypeId,
    employeeId,
    year,
    today: todayStr(),
    canApply: !!req.hrm.employee || req.hrm.isHR,
  });
});

export const apply = safe(async (req, res) => {
  const b = pick(
    req.body,
    ["employeeId", "leaveTypeId", "startDate", "endDate", "reason"],
    ["reason"],
  );
  let employee = req.hrm.employee;
  if (req.hrm.isHR && b.employeeId)
    employee = await Employee.findByPk(b.employeeId);
  if (!employee)
    throw new HrmError(
      "No employee record is linked to your account. Ask HR to link it.",
    );
  await applyLeave({ employee, ...b, actorId: req.hrm.user.id });
  req.flash(
    "success_msg",
    "Leave application submitted and awaiting approval.",
  );
  res.redirect("/hrm/leave");
});
export const approve = safe(async (req, res) => {
  await approveLeave(req.params.id, req.hrm.user.id, req.body.remarks);
  req.flash(
    "success_msg",
    "Leave approved. Balance and attendance were updated.",
  );
  res.redirect(back(req, "/hrm/leave"));
});
export const reject = safe(async (req, res) => {
  await rejectLeave(
    req.params.id,
    req.hrm.user.id,
    (req.body.remarks || "").trim() || null,
  );
  req.flash("success_msg", "Leave rejected.");
  res.redirect(back(req, "/hrm/leave"));
});
export const cancel = safe(async (req, res) => {
  await cancelLeave(req.params.id, {
    employeeId: req.hrm.employee?.id,
    isHR: req.hrm.isHR,
    actorId: req.hrm.user.id,
  });
  req.flash("success_msg", "Leave request cancelled.");
  res.redirect(back(req, "/hrm/leave"));
});

// ---- Balances ----
export const balances = safe(async (req, res) => {
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const { departmentId = "", leaveTypeId = "", q = "" } = req.query;
  await ensureBalances(year, req.hrm.isHR ? null : [req.hrm.employee.id]);
  const empWhere = { isActive: true };
  if (!req.hrm.isHR) empWhere.id = req.hrm.employee.id;
  if (departmentId) empWhere.departmentId = departmentId;
  if (q.trim())
    empWhere[Op.or] = ["firstName", "lastName", "employeeNo"].map((f) => ({
      [f]: { [Op.like]: `%${q.trim()}%` },
    }));
  const where = { year };
  if (leaveTypeId) where.leaveTypeId = leaveTypeId;
  const rows = await LeaveBalance.findAll({
    where,
    include: [
      {
        model: Employee,
        as: "employee",
        where: empWhere,
        include: [{ model: Department, as: "department" }],
      },
      { model: LeaveType, as: "leaveType" },
    ],
    order: [
      [{ model: Employee, as: "employee" }, "lastName", "ASC"],
      [{ model: LeaveType, as: "leaveType" }, "name", "ASC"],
    ],
  });
  res.render("hrm/leave/balances", {
    title: "Leave Balances",
    active: "balances",
    year,
    q,
    departmentId,
    leaveTypeId,
    rows: plain(rows).map((r) => ({ ...r, remaining: r.entitled - r.used })),
    types: plain(
      await LeaveType.findAll({
        where: { isActive: true, isPaid: true },
        order: [["name", "ASC"]],
      }),
    ),
    departments: plain(await Department.findAll({ order: [["name", "ASC"]] })),
  });
});
export const updateBalance = safe(async (req, res) => {
  const b = await LeaveBalance.findByPk(req.params.id);
  const entitled = Number(req.body.entitled);
  if (!b || Number.isNaN(entitled) || entitled < 0)
    throw new HrmError("Enter a valid entitlement.");
  if (entitled < b.used)
    throw new HrmError(
      `Entitlement cannot be lower than days already used (${b.used}).`,
    );
  await b.update({ entitled });
  req.flash("success_msg", "Leave balance updated.");
  res.redirect(back(req, "/hrm/leave/balances"));
});

// ---- Leave types ----
export const typesIndex = safe(async (req, res) => {
  const types = await LeaveType.findAll({ order: [["name", "ASC"]] });
  res.render("hrm/leave/types", {
    title: "Leave Types",
    active: "leavetypes",
    rows: plain(types),
  });
});
const typeFields = (b) => ({
  ...pick(b, ["name", "description"], ["description"]),
  defaultDays: Math.max(0, Number(b.defaultDays) || 0),
  isPaid: bool(b.isPaid),
  isActive: b.isActive === undefined ? true : bool(b.isActive),
});
export const typeCreate = safe(async (req, res) => {
  await LeaveType.create(typeFields(req.body));
  req.flash("success_msg", "Leave type created.");
  res.redirect("/hrm/leave/types");
});
export const typeUpdate = safe(async (req, res) => {
  const t = await LeaveType.findByPk(req.params.id);
  if (t) await t.update(typeFields(req.body));
  req.flash("success_msg", "Leave type updated.");
  res.redirect("/hrm/leave/types");
});
export const typeDelete = safe(async (req, res) => {
  await LeaveType.destroy({ where: { id: req.params.id } });
  req.flash("success_msg", "Leave type deleted.");
  res.redirect("/hrm/leave/types");
});
