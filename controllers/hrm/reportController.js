import { Op } from "sequelize";
import {
  Department,
  Position,
  Employee,
  Attendance,
  LeaveRequest,
  LeaveType,
  Assignment,
} from "../../models/hrm/index.js";
import {
  todayStr,
  isDate,
  hoursBetween,
} from "../../models/hrm/services/hrmUtils.js";
import { getAttendanceReportRows } from "../../models/hrm/services/hrmService.js";
import { safe, plain } from "./_shared.js";

const TYPES = {
  employees: "Employee Report",
  attendance: "Attendance Summary",
  attendance_log: "Attendance Log (daily)",
  leave: "Leave Report",
  assignments: "Employee Assignment Report",
};
const label = (s) =>
  s
    ? String(s)
        .replace(/[_-]/g, " ")
        .replace(/^\w/, (c) => c.toUpperCase())
    : "";

async function build(type, f) {
  const empWhere = {};
  if (f.departmentId) empWhere.departmentId = f.departmentId;
  if (f.employeeId) empWhere.id = f.employeeId;
  const empInc = (extra = {}) => ({
    model: Employee,
    as: "employee",
    where: empWhere,
    include: [{ model: Department, as: "department" }],
    ...extra,
  });
  if (type === "employees") {
    const where = { ...empWhere };
    if (f.status) where.employmentStatus = f.status;
    const rows = await Employee.findAll({
      where,
      include: [
        { model: Department, as: "department" },
        { model: Position, as: "position" },
      ],
      order: [["lastName", "ASC"]],
    });
    return {
      columns: [
        "Employee No",
        "Name",
        "Department",
        "Position",
        "Status",
        "Hire Date",
        "Phone",
        "Email",
        "Active",
      ],
      rows: rows.map((e) => [
        e.employeeNo,
        e.fullName,
        e.department?.name,
        e.position?.title,
        label(e.employmentStatus),
        e.hireDate,
        e.phone,
        e.email,
        e.isActive ? "Yes" : "No",
      ]),
    };
  }
  if (type === "attendance") {
    const emps = await Employee.findAll({
      where: { ...empWhere, hireDate: { [Op.lte]: f.to } },
      include: [{ model: Department, as: "department" }],
      order: [["lastName", "ASC"]],
    });
    const reportRows = await getAttendanceReportRows(emps, f.from, f.to);
    return {
      columns: [
        "Employee No",
        "Name",
        "Department",
        "Scheduled Days",
        "Present",
        "Late",
        "Absent",
        "On Leave",
        "Minutes Late",
        "Hours Worked",
      ],
      rows: emps.map((e) => {
        const s = reportRows.get(e.id) || {
          scheduledDays: 0,
          present: 0,
          late: 0,
          absent: 0,
          onLeave: 0,
          minutesLate: 0,
          hoursWorked: 0,
        };
        return [
          e.employeeNo,
          e.fullName,
          e.department?.name,
          s.scheduledDays,
          s.present,
          s.late,
          s.absent,
          s.onLeave,
          s.minutesLate,
          s.hoursWorked.toFixed(1),
        ];
      }),
    };
  }
  if (type === "attendance_log") {
    const where = { date: { [Op.between]: [f.from, f.to] } };
    if (f.status) where.status = f.status;
    const rows = await Attendance.findAll({
      where,
      include: [empInc()],
      order: [
        ["date", "DESC"],
        [{ model: Employee, as: "employee" }, "lastName", "ASC"],
      ],
    });
    return {
      columns: [
        "Date",
        "Employee No",
        "Name",
        "Department",
        "Time In",
        "Time Out",
        "Status",
        "Minutes Late",
        "Hours",
      ],
      rows: rows.map((r) => [
        r.date,
        r.employee.employeeNo,
        r.employee.fullName,
        r.employee.department?.name,
        r.timeIn?.slice(0, 5),
        r.timeOut?.slice(0, 5),
        label(r.status),
        r.minutesLate,
        hoursBetween(r.timeIn, r.timeOut).toFixed(1),
      ]),
    };
  }
  if (type === "leave") {
    const where = {
      startDate: { [Op.lte]: f.to },
      endDate: { [Op.gte]: f.from },
    };
    if (f.status) where.status = f.status;
    const rows = await LeaveRequest.findAll({
      where,
      include: [empInc(), { model: LeaveType, as: "leaveType" }],
      order: [["startDate", "DESC"]],
    });
    return {
      columns: [
        "Employee No",
        "Name",
        "Department",
        "Leave Type",
        "From",
        "To",
        "Days",
        "Status",
        "Reason",
      ],
      rows: rows.map((r) => [
        r.employee.employeeNo,
        r.employee.fullName,
        r.employee.department?.name,
        r.leaveType.name,
        r.startDate,
        r.endDate,
        r.days,
        label(r.status),
        r.reason,
      ]),
    };
  }
  const where = {
    startDate: { [Op.lte]: f.to },
    [Op.or]: [{ endDate: null }, { endDate: { [Op.gte]: f.from } }],
  };
  if (f.status) where.status = f.status;
  const rows = await Assignment.findAll({
    where,
    include: [empInc()],
    order: [
      ["projectName", "ASC"],
      ["startDate", "DESC"],
    ],
  });
  return {
    columns: [
      "Project",
      "Site",
      "Employee No",
      "Name",
      "Department",
      "Role on Project",
      "Start",
      "End",
      "Status",
    ],
    rows: rows.map((a) => [
      a.projectName,
      a.siteName,
      a.employee.employeeNo,
      a.employee.fullName,
      a.employee.department?.name,
      a.roleOnProject,
      a.startDate,
      a.endDate || "Ongoing",
      label(a.status),
    ]),
  };
}

export const csvCell = (v) => {
  let s = v === null || v === undefined ? "" : String(v);
  // Spreadsheet formula injection guard: neutralize cells that start like formulas.
  if (/^\s*[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const index = safe(async (req, res) => {
  const type = TYPES[req.query.type] ? req.query.type : "employees";
  const today = todayStr();
  const f = {
    from: isDate(req.query.from) ? req.query.from : `${today.slice(0, 7)}-01`,
    to: isDate(req.query.to) ? req.query.to : today,
    departmentId: req.query.departmentId || "",
    employeeId: req.query.employeeId || "",
    status: req.query.status || "",
  };
  const { columns, rows } = await build(type, f);
  if (req.query.format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="rektabuild-hrm-${type}-${today}.csv"`,
    );
    return res.send(
      "\uFEFF" +
        [columns, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n"),
    );
  }
  const perPage = 100;
  const totalRows = rows.length;
  const pages = Math.max(1, Math.ceil(totalRows / perPage));
  const page = Math.min(
    pages,
    Math.max(1, parseInt(req.query.page || "1", 10) || 1),
  );
  const pageRows = rows.slice((page - 1) * perPage, page * perPage);
  const qs = new URLSearchParams({ type, ...f }).toString();
  res.render("hrm/reports/index", {
    title: "HR Reports",
    active: "reports",
    type,
    types: Object.entries(TYPES).map(([k, v]) => ({ key: k, name: v })),
    typeName: TYPES[type],
    ...f,
    columns,
    rows: pageRows,
    totalRows,
    page,
    pages,
    hasPrev: page > 1,
    hasNext: page < pages,
    showPager: pages > 1,
    prevPage: page - 1,
    nextPage: page + 1,
    qs,
    generated: new Date().toLocaleString("en-US"),
    usesDates: type !== "employees",
    showStatus: type !== "attendance",
    departments: plain(await Department.findAll({ order: [["name", "ASC"]] })),
    employees: plain(await Employee.findAll({ order: [["lastName", "ASC"]] })),
  });
});
