import { Op } from "sequelize";
import {
  Department,
  Employee,
  Attendance,
  LeaveRequest,
} from "../../models/hrm/index.js";
import {
  HrmError,
  todayStr,
  addDays,
  parseDate,
  pad,
  dow,
  normTime,
  isDate,
  isWorkday,
  eachDate,
  hoursBetween,
  DEFAULT_SHIFT,
} from "../../models/hrm/services/hrmUtils.js";
import {
  recordTimeIn,
  recordTimeOut,
  upsertAttendance,
  getScheduleMap,
  getAttendanceSummary,
  deleteAttendance,
} from "../../models/hrm/services/hrmService.js";
import { safe, back, plain, pick, intOrNull } from "./_shared.js";

const selfCard = async (req) => {
  const emp = req.hrm.employee;
  if (!emp) return null;
  const today = todayStr();
  const recs = await Attendance.findAll({
    where: { employeeId: emp.id, date: [today, addDays(today, -1)] },
    order: [["date", "DESC"]],
  });
  const record =
    recs.find((r) => r.date === today) ||
    recs.find((r) => r.timeIn && !r.timeOut) ||
    null;
  return { employee: emp.get({ plain: true }), record: plain(record) };
};

/** HR: daily monitoring. Everyone else: their own recent history. */
export const index = safe(async (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : todayStr();
  const today = todayStr();
  const self = await selfCard(req);
  if (!req.hrm.isHR) {
    const recs = await Attendance.findAll({
      where: { employeeId: req.hrm.employee.id },
      order: [["date", "DESC"]],
      limit: 31,
    });
    return res.render("hrm/attendance/mine", {
      title: "My Attendance",
      active: "attendance",
      self,
      today,
      rows: plain(recs).map((r) => ({
        ...r,
        hours: hoursBetween(r.timeIn, r.timeOut).toFixed(1),
      })),
      summary: await getAttendanceSummary(
        req.hrm.employee.id,
        `${today.slice(0, 7)}-01`,
        today,
      ),
    });
  }
  const { q = "", departmentId = "", status = "" } = req.query;
  const where = { isActive: true, hireDate: { [Op.lte]: date } };
  if (departmentId) where.departmentId = departmentId;
  const tokens = q.trim().split(/\s+/).filter(Boolean);
  if (tokens.length)
    where[Op.and] = tokens.map((t) => ({
      [Op.or]: ["firstName", "lastName", "employeeNo"].map((f) => ({
        [f]: { [Op.like]: `%${t}%` },
      })),
    }));
  const emps = await Employee.findAll({
    where,
    include: [{ model: Department, as: "department" }],
    order: [
      ["lastName", "ASC"],
      ["firstName", "ASC"],
    ],
  });
  const ids = emps.map((e) => e.id);
  const [recs, leaves, smap] = await Promise.all([
    Attendance.findAll({ where: { date, employeeId: ids } }),
    LeaveRequest.findAll({
      where: {
        status: "approved",
        startDate: { [Op.lte]: date },
        endDate: { [Op.gte]: date },
        employeeId: ids,
      },
      attributes: ["employeeId"],
    }),
    getScheduleMap(date, ids),
  ]);
  const recMap = new Map(
    recs.map((r) => [r.employeeId, r.get({ plain: true })]),
  );
  const onLeave = new Set(leaves.map((l) => l.employeeId));
  const counts = {
    present: 0,
    late: 0,
    absent: 0,
    on_leave: 0,
    not_in: 0,
    day_off: 0,
  };
  let rows = plain(emps).map((e) => {
    const record = recMap.get(e.id) || null;
    const sch = smap.get(e.id) || DEFAULT_SHIFT;
    let st,
      derived = false;
    if (record) st = record.status === "half_day" ? "present" : record.status;
    else if (onLeave.has(e.id)) st = "on_leave";
    else if (!isWorkday(date, sch.workDays)) st = "day_off";
    else if (date > today) st = "day_off";
    else if (date === today) st = "not_in";
    else {
      st = "absent";
      derived = true;
    }
    counts[st] = (counts[st] || 0) + 1;
    return {
      employee: e,
      record,
      status: st,
      derived,
      shiftStart: sch.shiftStart,
      hours: record
        ? hoursBetween(record.timeIn, record.timeOut).toFixed(1)
        : "",
    };
  });
  if (status) rows = rows.filter((r) => r.status === status);
  res.render("hrm/attendance/index", {
    title: "Daily Attendance",
    active: "attendance",
    date,
    today,
    prevDate: addDays(date, -1),
    nextDate: addDays(date, 1),
    self,
    rows,
    counts,
    q,
    departmentId,
    status,
    isPast: date < today,
    departments: plain(await Department.findAll({ order: [["name", "ASC"]] })),
  });
});

export const timeIn = safe(async (req, res) => {
  if (!req.hrm.employee)
    throw new HrmError(
      "Your account is not linked to an employee record. Ask HR to link it.",
    );
  const r = await recordTimeIn(req.hrm.employee);
  req.flash(
    "success_msg",
    r.status === "late"
      ? `Timed in at ${r.timeIn.slice(0, 5)} — marked late by ${r.minutesLate} min.`
      : `Timed in at ${r.timeIn.slice(0, 5)}. Have a safe shift!`,
  );
  res.redirect(back(req, "/hrm/attendance"));
});
export const timeOut = safe(async (req, res) => {
  if (!req.hrm.employee)
    throw new HrmError("Your account is not linked to an employee record.");
  const r = await recordTimeOut(req.hrm.employee);
  req.flash("success_msg", `Timed out at ${r.timeOut.slice(0, 5)}. Thank you!`);
  res.redirect(back(req, "/hrm/attendance"));
});

export const save = safe(async (req, res) => {
  const b = pick(
    req.body,
    ["employeeId", "date", "timeIn", "timeOut", "status", "remarks"],
    ["timeIn", "timeOut", "remarks"],
  );
  const emp = await Employee.findByPk(b.employeeId);
  if (!emp) throw new HrmError("Employee not found.");
  if (!isDate(b.date)) throw new HrmError("A valid date is required.");
  if (b.date > todayStr())
    throw new HrmError("Attendance cannot be recorded for a future date.");
  if (b.date < emp.hireDate)
    throw new HrmError("Attendance cannot be recorded before the hire date.");
  await upsertAttendance(
    {
      employeeId: emp.id,
      date: b.date,
      timeIn: normTime(b.timeIn),
      timeOut: normTime(b.timeOut),
      status: b.status,
      remarks: b.remarks,
    },
    { changedBy: req.hrm.user.id },
  );
  req.flash("success_msg", `Attendance saved for ${emp.fullName}.`);
  res.redirect(back(req, "/hrm/attendance"));
});
export const remove = safe(async (req, res) => {
  await deleteAttendance(Number(req.params.id), { changedBy: req.hrm.user.id });
  req.flash("success_msg", "Attendance record deleted.");
  res.redirect(back(req, "/hrm/attendance"));
});

/** Creates 'absent' rows for scheduled workdays with no record and no approved leave (past dates only). */
export const generateAbsences = safe(async (req, res) => {
  const date = req.body.date;
  if (!isDate(date) || date >= todayStr())
    throw new HrmError("Choose a past date to generate absences.");
  const emps = await Employee.findAll({
    where: { isActive: true, hireDate: { [Op.lte]: date } },
    attributes: ["id"],
  });
  const ids = emps.map((e) => e.id);
  const [smap, recs, leaves] = await Promise.all([
    getScheduleMap(date, ids),
    Attendance.findAll({
      where: { date, employeeId: ids },
      attributes: ["employeeId"],
    }),
    LeaveRequest.findAll({
      where: {
        status: "approved",
        startDate: { [Op.lte]: date },
        endDate: { [Op.gte]: date },
      },
      attributes: ["employeeId"],
    }),
  ]);
  const skip = new Set([
    ...recs.map((r) => r.employeeId),
    ...leaves.map((l) => l.employeeId),
  ]);
  const rows = ids
    .filter(
      (id) =>
        !skip.has(id) &&
        isWorkday(date, (smap.get(id) || DEFAULT_SHIFT).workDays),
    )
    .map((employeeId) => ({
      employeeId,
      date,
      status: "absent",
      remarks: "Auto-generated",
    }));
  if (rows.length)
    await Attendance.bulkCreate(rows, { ignoreDuplicates: true });
  req.flash(
    "success_msg",
    `${rows.length} absence record(s) generated for ${date}.`,
  );
  res.redirect(`/hrm/attendance?date=${date}`);
});

export const calendar = safe(async (req, res) => {
  let month = /^\d{4}-\d{2}$/.test(req.query.month || "")
    ? req.query.month
    : todayStr().slice(0, 7);
  const all = req.hrm.isHR
    ? await Employee.findAll({
        where: { isActive: true },
        order: [["lastName", "ASC"]],
      })
    : [];
  const empId = req.hrm.isHR
    ? intOrNull(req.query.employeeId) || req.hrm.employee?.id || all[0]?.id
    : req.hrm.employee.id;
  const emp = empId ? await Employee.findByPk(empId) : null;
  if (!emp) {
    req.flash("error_msg", "No employee to display yet.");
    return res.redirect("/hrm");
  }
  const [y, m] = month.split("-").map(Number);
  const first = `${month}-01`,
    last = `${month}-${pad(new Date(y, m, 0).getDate())}`;
  const recs = await Attendance.findAll({
    where: { employeeId: emp.id, date: { [Op.between]: [first, last] } },
    order: [["date", "ASC"]],
  });
  const map = new Map(recs.map((r) => [r.date, r.get({ plain: true })]));
  const today = todayStr();
  const cells = [];
  for (let i = 0; i < dow(first); i++) cells.push(null);
  for (const d of eachDate(first, last)) {
    const r = map.get(d);
    cells.push({
      day: Number(d.slice(8)),
      date: d,
      record: r || null,
      status: r?.status || null,
      isToday: d === today,
      isFuture: d > today,
    });
  }
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) {
    const w = cells.slice(i, i + 7);
    while (w.length < 7) w.push(null);
    weeks.push(w);
  }
  const prev = `${new Date(y, m - 2, 1).getFullYear()}-${pad(new Date(y, m - 2, 1).getMonth() + 1)}`;
  const next = `${new Date(y, m, 1).getFullYear()}-${pad(new Date(y, m, 1).getMonth() + 1)}`;
  res.render("hrm/attendance/calendar", {
    title: "Attendance Calendar",
    active: "calendar",
    employee: plain(emp),
    employees: plain(all),
    month,
    prev,
    next,
    monthLabel: parseDate(first).toLocaleString("en-US", {
      month: "long",
      year: "numeric",
    }),
    weeks,
    summary: await getAttendanceSummary(
      emp.id,
      first,
      last < today ? last : today,
    ),
    history: plain(recs)
      .reverse()
      .map((r) => ({
        ...r,
        hours: hoursBetween(r.timeIn, r.timeOut).toFixed(1),
      })),
  });
});
