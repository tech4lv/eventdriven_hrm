import { fn, col } from "sequelize";
import {
  Department,
  Employee,
  LeaveRequest,
  LeaveType,
} from "../../models/hrm/index.js";
import { todayStr, addDays } from "../../models/hrm/services/hrmUtils.js";
import {
  dayRoster,
  getAttendanceTrend,
} from "../../models/hrm/services/hrmService.js";
import { safe, plain } from "./_shared.js";

export const index = safe(async (req, res) => {
  if (!req.hrm.isHR) return res.redirect("/hrm/attendance");
  const today = todayStr();
  const [
    total,
    active,
    pendingCount,
    pendingList,
    deptRows,
    statusRows,
    roster,
  ] = await Promise.all([
    Employee.count(),
    Employee.count({ where: { isActive: true } }),
    LeaveRequest.count({ where: { status: "pending" } }),
    LeaveRequest.findAll({
      where: { status: "pending" },
      order: [["createdAt", "ASC"]],
      limit: 5,
      include: [
        { model: Employee, as: "employee" },
        { model: LeaveType, as: "leaveType" },
      ],
    }),
    Employee.findAll({
      where: { isActive: true },
      attributes: ["departmentId", [fn("COUNT", col("HrmEmployee.id")), "n"]],
      group: ["departmentId"],
      include: [{ model: Department, as: "department", attributes: ["name"] }],
      raw: true,
      nest: true,
    }),
    Employee.findAll({
      where: { isActive: true },
      attributes: ["employmentStatus", [fn("COUNT", col("id")), "n"]],
      group: ["employmentStatus"],
      raw: true,
    }),
    dayRoster(today),
  ]);
  const late = roster.recs.filter((r) => r.status === "late").length;
  const present = roster.checkedIn.size;
  const onLeave = roster.scheduled.filter(
    (id) => roster.onLeave.has(id) && !roster.checkedIn.has(id),
  ).length;
  const absent = roster.scheduled.filter(
    (id) => !roster.checkedIn.has(id) && !roster.onLeave.has(id),
  ).length;

  // Last 7 days using the schedule effective on each date.
  const days = [-6, -5, -4, -3, -2, -1, 0].map((n) => addDays(today, n));
  const trendRows = await getAttendanceTrend(days[0], today);
  const trend = trendRows.map((r) => ({
    date: r.date.slice(5),
    present: r.present,
    late: r.late,
    leave: r.leave,
    absent: r.absent,
  }));
  const charts = {
    dept: {
      labels: deptRows.map((r) => r.department?.name || "Unassigned"),
      data: deptRows.map((r) => Number(r.n)),
    },
    status: {
      labels: statusRows.map((r) => r.employmentStatus),
      data: statusRows.map((r) => Number(r.n)),
    },
    trend,
  };
  res.render("hrm/dashboard", {
    title: "HR Dashboard",
    active: "dashboard",
    total,
    active_n: active,
    present,
    late,
    absent,
    onLeave,
    pendingCount,
    pending: plain(pendingList),
    chartJson: JSON.stringify(charts).replace(/</g, "\\u003c"),
    today,
  });
});
