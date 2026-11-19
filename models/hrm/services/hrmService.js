/*
  HRM service layer.
  Section A: business rules used by HRM controllers.
  Section B: READ-ONLY public API for other RektaBuild modules (Supply, Accounting,
             Inventory, PayrollMS). Other modules must call these functions (or the
             /api/hrm endpoints) instead of querying hrm_* tables directly.
  HRM does no payroll or disbursement and stores no salary data. getAttendanceSummary and
  getPayrollInputs only report attendance/leave facts; PayrollMS owns rates, computation and pay.
*/
import { EventEmitter } from "events";
import { Op, fn, col } from "sequelize";
import {
  sequelize,
  Department,
  Position,
  Employee,
  WorkSchedule,
  Attendance,
  AttendanceAudit,
  LeaveType,
  LeaveBalance,
  LeaveRequest,
  LeaveAudit,
  Assignment,
} from "../index.js";
import {
  HrmError,
  todayStr,
  nowTime,
  addDays,
  eachDate,
  isWorkday,
  isDate,
  deriveStatus,
  hoursBetween,
  toMin,
  normTime,
  isTime,
  normLabel,
  DEFAULT_SHIFT,
} from "./hrmUtils.js";

export { HrmError };
/** Events: employee.created, employee.updated, employee.statusChanged, assignment.changed, leave.reviewed */
export const hrmEvents = new EventEmitter();

const attendanceSnapshot = (r) => {
  const p = r?.get ? r.get({ plain: true }) : r;
  return p
    ? {
        date: p.date,
        timeIn: p.timeIn,
        timeOut: p.timeOut,
        status: p.status,
        minutesLate: p.minutesLate,
        remarks: p.remarks,
      }
    : null;
};

async function auditAttendance({
  attendanceId,
  employeeId,
  action,
  changedBy = null,
  oldValues = null,
  newValues = null,
  transaction = null,
}) {
  await AttendanceAudit.create(
    {
      attendanceId: attendanceId ?? null,
      employeeId,
      action,
      oldValues,
      newValues,
      changedBy,
    },
    transaction ? { transaction } : {},
  );
}

async function auditLeave({
  leaveRequestId,
  employeeId,
  action,
  actorId = null,
  oldValues = null,
  newValues = null,
  transaction = null,
}) {
  await LeaveAudit.create(
    {
      leaveRequestId,
      employeeId,
      action,
      actorId,
      oldValues,
      newValues,
    },
    transaction ? { transaction } : {},
  );
}

const txOpts = (transaction) => (transaction ? { transaction } : {});
const lockOpts = (transaction) =>
  transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {};

// ===================== A. Business rules =====================

export async function nextEmployeeNo() {
  const prefix = `RB-${new Date().getFullYear()}-`;
  const last = await Employee.findOne({
    where: { employeeNo: { [Op.like]: `${prefix}%` } },
    order: [["employeeNo", "DESC"]],
  });
  const n = last ? parseInt(last.employeeNo.split("-")[2], 10) + 1 : 1;
  return prefix + String(n).padStart(4, "0");
}

/** Schedule effective on a date (falls back to Mon-Sat 8-5). */
export async function getSchedule(employeeId, date, { transaction } = {}) {
  const s = await WorkSchedule.findOne({
    where: {
      employeeId,
      effectiveFrom: { [Op.lte]: date },
      [Op.or]: [{ effectiveTo: null }, { effectiveTo: { [Op.gte]: date } }],
    },
    order: [["effectiveFrom", "DESC"]],
    ...txOpts(transaction),
  });
  return s ? s.get({ plain: true }) : { ...DEFAULT_SHIFT };
}

/** Map employeeId -> schedule effective on date, for a list of employee ids. */
export async function getScheduleMap(date, employeeIds, { transaction } = {}) {
  const rows = await WorkSchedule.findAll({
    where: {
      employeeId: employeeIds,
      effectiveFrom: { [Op.lte]: date },
      [Op.or]: [{ effectiveTo: null }, { effectiveTo: { [Op.gte]: date } }],
    },
    order: [["effectiveFrom", "ASC"]],
    ...txOpts(transaction),
  });
  const map = new Map();
  rows.forEach((r) => map.set(r.employeeId, r.get({ plain: true }))); // later rows win
  return map;
}

async function scheduleRowsForRange(
  employeeId,
  from,
  to,
  { transaction } = {},
) {
  return WorkSchedule.findAll({
    where: {
      employeeId,
      effectiveFrom: { [Op.lte]: to },
      [Op.or]: [{ effectiveTo: null }, { effectiveTo: { [Op.gte]: from } }],
    },
    order: [["effectiveFrom", "ASC"]],
    ...txOpts(transaction),
  });
}

function scheduleForDate(rows, date) {
  let best = null;
  for (const row of rows) {
    const s = row.get ? row.get({ plain: true }) : row;
    if (
      s.effectiveFrom <= date &&
      (s.effectiveTo === null || s.effectiveTo >= date) &&
      (!best || s.effectiveFrom > best.effectiveFrom)
    )
      best = s;
  }
  return best || { ...DEFAULT_SHIFT };
}

/** Workdays in a range using the schedule effective on each date. */
export async function workDatesInRange(
  employeeId,
  from,
  to,
  { transaction } = {},
) {
  const rows = await scheduleRowsForRange(employeeId, from, to, {
    transaction,
  });
  return eachDate(from, to).filter((d) =>
    isWorkday(d, scheduleForDate(rows, d).workDays),
  );
}

export async function countLeaveDays(employeeId, from, to, opts = {}) {
  return (await workDatesInRange(employeeId, from, to, opts)).length;
}

async function scheduleRowsForEmployees(
  employeeIds,
  from,
  to,
  { transaction } = {},
) {
  const rows = await WorkSchedule.findAll({
    where: {
      employeeId: employeeIds,
      effectiveFrom: { [Op.lte]: to },
      [Op.or]: [{ effectiveTo: null }, { effectiveTo: { [Op.gte]: from } }],
    },
    order: [
      ["employeeId", "ASC"],
      ["effectiveFrom", "ASC"],
    ],
    ...txOpts(transaction),
  });
  const map = new Map();
  for (const row of rows) {
    const s = row.get({ plain: true });
    const list = map.get(s.employeeId);
    if (list) list.push(s);
    else map.set(s.employeeId, [s]);
  }
  return map;
}

function countWorkdaysWithRows(rows, from, to) {
  if (from > to) return 0;
  return eachDate(from, to).filter((d) =>
    isWorkday(d, scheduleForDate(rows, d).workDays),
  ).length;
}

async function findOpenAttendance(employeeId, date, transaction) {
  return Attendance.findOne({
    where: {
      employeeId,
      date: [date, addDays(date, -1)],
      timeIn: { [Op.ne]: null },
      timeOut: null,
    },
    order: [["date", "DESC"]],
    ...lockOpts(transaction),
  });
}

export async function recordTimeIn(employee, now = new Date()) {
  if (!employee.isActive)
    throw new HrmError("Inactive employees cannot time in.");
  return sequelize.transaction(async (t) => {
    const date = todayStr(now),
      time = nowTime(now);
    const open = await findOpenAttendance(employee.id, date, t);
    if (open) {
      if (open.date === date)
        throw new HrmError("You have already timed in today.");
      throw new HrmError(
        "You have an open time-in from yesterday. Time out before starting a new shift.",
      );
    }
    let rec = await Attendance.findOne({
      where: { employeeId: employee.id, date },
      ...lockOpts(t),
    });
    if (rec?.timeIn) throw new HrmError("You have already timed in today.");
    if (rec?.status === "on_leave")
      throw new HrmError(
        "You are on approved leave today. Contact HR to adjust the record.",
      );
    const sch = await getSchedule(employee.id, date, { transaction: t });
    const d = deriveStatus(time, sch.shiftStart);
    const old = attendanceSnapshot(rec);
    if (rec) await rec.update({ timeIn: time, ...d }, { transaction: t });
    else
      rec = await Attendance.create(
        { employeeId: employee.id, date, timeIn: time, ...d },
        { transaction: t },
      );
    await auditAttendance({
      attendanceId: rec.id,
      employeeId: employee.id,
      action: "time_in",
      changedBy: employee.userId,
      oldValues: old,
      newValues: attendanceSnapshot(rec),
      transaction: t,
    });
    return rec;
  });
}

export async function recordTimeOut(employee, now = new Date()) {
  return sequelize.transaction(async (t) => {
    const date = todayStr(now),
      time = nowTime(now);
    const rec = await findOpenAttendance(employee.id, date, t);
    if (!rec) {
      const todayRec = await Attendance.findOne({
        where: { employeeId: employee.id, date },
        ...txOpts(t),
      });
      if (todayRec?.timeOut)
        throw new HrmError("You have already timed out today.");
      throw new HrmError("You need to time in before timing out.");
    }
    if (rec.date < date && toMin(time) >= toMin(rec.timeIn))
      throw new HrmError(
        "That time-in is too old to time out. Ask HR to correct it.",
      );
    const old = attendanceSnapshot(rec);
    await rec.update({ timeOut: time }, { transaction: t });
    await auditAttendance({
      attendanceId: rec.id,
      employeeId: employee.id,
      action: "time_out",
      changedBy: employee.userId,
      oldValues: old,
      newValues: attendanceSnapshot(rec),
      transaction: t,
    });
    return rec;
  });
}

const ATTENDANCE_STATUSES = new Set([
  "present",
  "late",
  "absent",
  "on_leave",
  "half_day",
]);

export async function upsertAttendance(
  { employeeId, date, timeIn, timeOut, status, remarks },
  { transaction = null, changedBy = null, auditAction = "manual_save" } = {},
) {
  if (!isDate(date)) throw new HrmError("A valid date is required.");
  const inT = normTime(timeIn);
  const outT = normTime(timeOut);
  if (outT && !inT) throw new HrmError("Time-out requires a time-in.");
  // Time-out earlier than time-in is allowed: it means an overnight shift (e.g. 22:00 -> 06:00).
  if (inT && outT && toMin(outT) === toMin(inT))
    throw new HrmError("Time-out must differ from time-in.");
  if (status && status !== "auto" && !ATTENDANCE_STATUSES.has(status))
    throw new HrmError("Invalid attendance status.");
  const note =
    remarks === null || remarks === undefined ? null : String(remarks).trim();
  if (note && note.length > 255)
    throw new HrmError("Remarks must be 255 characters or fewer.");
  const sch = await getSchedule(employeeId, date, { transaction });
  let data;
  if (!status || status === "auto") {
    data = deriveStatus(inT, sch.shiftStart);
  } else {
    data = {
      status,
      minutesLate:
        status === "late" && inT
          ? Math.max(0, toMin(inT) - toMin(sch.shiftStart))
          : 0,
    };
  }
  const payload = {
    ...data,
    timeIn: inT,
    timeOut: outT,
    remarks: note || null,
  };
  const rec = await Attendance.findOne({
    where: { employeeId, date },
    ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}),
  });
  const old = attendanceSnapshot(rec);
  const saved = rec
    ? await rec.update(payload, txOpts(transaction))
    : await Attendance.create(
        { employeeId, date, ...payload },
        txOpts(transaction),
      );
  await auditAttendance({
    attendanceId: saved.id,
    employeeId,
    action: auditAction,
    changedBy,
    oldValues: old,
    newValues: attendanceSnapshot(saved),
    transaction,
  });
  return saved;
}

export async function saveWorkSchedule({
  employeeId,
  workDays,
  shiftStart,
  shiftEnd,
  effectiveFrom,
}) {
  if (!isDate(effectiveFrom))
    throw new HrmError("A valid effective date is required.");
  const days = [
    ...new Set(
      (Array.isArray(workDays) ? workDays : String(workDays || "").split(","))
        .map((d) => String(d).trim())
        .filter((d) => /^[0-6]$/.test(d)),
    ),
  ]
    .sort()
    .join(",");
  if (!days) throw new HrmError("Select at least one work day.");
  const start = normTime(shiftStart);
  const end = normTime(shiftEnd);
  if (!start || !end) throw new HrmError("Shift start and end are required.");
  if (toMin(start) === toMin(end))
    throw new HrmError("Shift end must differ from shift start.");
  return sequelize.transaction(async (t) => {
    const covering = await WorkSchedule.findOne({
      where: {
        employeeId,
        effectiveFrom: { [Op.lte]: effectiveFrom },
        [Op.or]: [
          { effectiveTo: null },
          { effectiveTo: { [Op.gte]: effectiveFrom } },
        ],
      },
      order: [["effectiveFrom", "DESC"]],
      ...lockOpts(t),
    });
    const next = await WorkSchedule.findOne({
      where: { employeeId, effectiveFrom: { [Op.gt]: effectiveFrom } },
      order: [["effectiveFrom", "ASC"]],
      ...lockOpts(t),
    });
    const nextTo = next ? addDays(next.effectiveFrom, -1) : null;
    if (covering?.effectiveFrom === effectiveFrom) {
      await covering.update(
        {
          workDays: days,
          shiftStart: start,
          shiftEnd: end,
          effectiveTo: covering.effectiveTo ?? nextTo,
        },
        { transaction: t },
      );
      return covering;
    }
    if (covering)
      await covering.update(
        { effectiveTo: addDays(effectiveFrom, -1) },
        { transaction: t },
      );
    return WorkSchedule.create(
      {
        employeeId,
        workDays: days,
        shiftStart: start,
        shiftEnd: end,
        effectiveFrom,
        effectiveTo: nextTo,
      },
      { transaction: t },
    );
  });
}

export async function ensureBalances(year, employeeIds = null) {
  const types = await LeaveType.findAll({
    where: { isActive: true, isPaid: true },
  });
  const emps = await Employee.findAll({
    where: { isActive: true, ...(employeeIds ? { id: employeeIds } : {}) },
    attributes: ["id"],
  });
  if (!types.length || !emps.length) return;
  const existing = await LeaveBalance.findAll({
    where: { year, employeeId: emps.map((e) => e.id) },
    attributes: ["employeeId", "leaveTypeId"],
  });
  const have = new Set(existing.map((b) => `${b.employeeId}:${b.leaveTypeId}`));
  const rows = [];
  for (const e of emps)
    for (const t of types)
      if (!have.has(`${e.id}:${t.id}`))
        rows.push({
          employeeId: e.id,
          leaveTypeId: t.id,
          year,
          entitled: t.defaultDays,
          used: 0,
        });
  if (rows.length)
    await LeaveBalance.bulkCreate(rows, { ignoreDuplicates: true });
}

export async function applyLeave({
  employee,
  leaveTypeId,
  startDate,
  endDate,
  reason,
  actorId = null,
}) {
  if (!isDate(startDate) || !isDate(endDate))
    throw new HrmError("Start and end dates are required.");
  if (endDate < startDate)
    throw new HrmError("End date cannot be before the start date.");
  if (startDate.slice(0, 4) !== endDate.slice(0, 4))
    throw new HrmError(
      "Leave cannot span two calendar years. Please file separate requests.",
    );
  if (!employee.isActive)
    throw new HrmError("Inactive employees cannot file leave.");
  const type = await LeaveType.findByPk(leaveTypeId);
  if (!type || !type.isActive)
    throw new HrmError("Please choose a valid leave type.");
  const days = await countLeaveDays(employee.id, startDate, endDate);
  if (days <= 0)
    throw new HrmError("The selected dates contain no working days.");
  const overlap = await LeaveRequest.findOne({
    where: {
      employeeId: employee.id,
      status: ["pending", "approved"],
      startDate: { [Op.lte]: endDate },
      endDate: { [Op.gte]: startDate },
    },
  });
  if (overlap)
    throw new HrmError(
      "You already have a pending or approved leave overlapping these dates.",
    );
  if (type.isPaid) {
    const year = Number(startDate.slice(0, 4));
    await ensureBalances(year, [employee.id]);
    const bal = await LeaveBalance.findOne({
      where: { employeeId: employee.id, leaveTypeId: type.id, year },
    });
    const pending = Number(
      (await LeaveRequest.sum("days", {
        where: {
          employeeId: employee.id,
          leaveTypeId: type.id,
          status: "pending",
          startDate: { [Op.between]: [`${year}-01-01`, `${year}-12-31`] },
        },
      })) || 0,
    );
    const remaining = (bal?.entitled || 0) - (bal?.used || 0) - pending;
    if (days > remaining)
      throw new HrmError(
        `Insufficient ${type.name} balance: ${remaining} day(s) available, ${days} requested.`,
      );
  }
  const req = await LeaveRequest.create({
    employeeId: employee.id,
    leaveTypeId: type.id,
    startDate,
    endDate,
    days,
    reason: reason || null,
  });
  await auditLeave({
    leaveRequestId: req.id,
    employeeId: employee.id,
    action: "submitted",
    actorId,
    newValues: {
      status: "pending",
      leaveTypeId: type.id,
      startDate,
      endDate,
      days,
    },
  });
  return req;
}

export async function approveLeave(id, reviewerUserId, remarks) {
  return sequelize.transaction(async (t) => {
    const req = await LeaveRequest.findByPk(id, {
      transaction: t,
      lock: t.LOCK.UPDATE,
      include: [{ model: LeaveType, as: "leaveType" }],
    });
    if (!req) throw new HrmError("Leave request not found.");
    if (req.status !== "pending")
      throw new HrmError("Only pending requests can be approved.");
    if (req.leaveType.isPaid) {
      const year = Number(req.startDate.slice(0, 4));
      const [bal] = await LeaveBalance.findOrCreate({
        where: {
          employeeId: req.employeeId,
          leaveTypeId: req.leaveTypeId,
          year,
        },
        defaults: { entitled: req.leaveType.defaultDays, used: 0 },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (bal.entitled - bal.used < req.days)
        throw new HrmError("The employee no longer has enough leave balance.");
      await bal.update({ used: bal.used + req.days }, { transaction: t });
    }
    for (const d of await workDatesInRange(
      req.employeeId,
      req.startDate,
      req.endDate,
      { transaction: t },
    )) {
      const rec = await Attendance.findOne({
        where: { employeeId: req.employeeId, date: d },
        ...lockOpts(t),
      });
      if (!rec)
        await Attendance.create(
          {
            employeeId: req.employeeId,
            date: d,
            status: "on_leave",
            remarks: req.leaveType.name,
            leaveRequestId: req.id,
          },
          { transaction: t },
        );
      else if (!rec.timeIn)
        await rec.update(
          {
            status: "on_leave",
            remarks: req.leaveType.name,
            leaveRequestId: req.id,
            statusBeforeLeave: rec.status,
            remarksBeforeLeave: rec.remarks,
          },
          { transaction: t },
        );
    }
    const reviewedAt = new Date();
    await req.update(
      {
        status: "approved",
        reviewedBy: reviewerUserId,
        reviewedAt,
        reviewRemarks: remarks || null,
      },
      { transaction: t },
    );
    await auditLeave({
      leaveRequestId: req.id,
      employeeId: req.employeeId,
      action: "approved",
      actorId: reviewerUserId,
      oldValues: { status: "pending" },
      newValues: {
        status: "approved",
        reviewedBy: reviewerUserId,
        reviewedAt,
        reviewRemarks: remarks || null,
      },
      transaction: t,
    });
    hrmEvents.emit("leave.reviewed", {
      id: req.id,
      status: "approved",
      employeeId: req.employeeId,
    });
    return req;
  });
}

export async function rejectLeave(id, reviewerUserId, remarks) {
  const req = await LeaveRequest.findByPk(id);
  if (!req) throw new HrmError("Leave request not found.");
  if (req.status !== "pending")
    throw new HrmError("Only pending requests can be rejected.");
  await req.update({
    status: "rejected",
    reviewedBy: reviewerUserId,
    reviewedAt: new Date(),
    reviewRemarks: remarks || null,
  });
  await auditLeave({
    leaveRequestId: req.id,
    employeeId: req.employeeId,
    action: "rejected",
    actorId: reviewerUserId,
    oldValues: { status: "pending" },
    newValues: { status: "rejected", reviewRemarks: remarks || null },
  });
  hrmEvents.emit("leave.reviewed", {
    id: req.id,
    status: "rejected",
    employeeId: req.employeeId,
  });
  return req;
}

export async function cancelLeave(id, { employeeId, isHR, actorId = null }) {
  return sequelize.transaction(async (t) => {
    const req = await LeaveRequest.findByPk(id, {
      transaction: t,
      lock: t.LOCK.UPDATE,
      include: [{ model: LeaveType, as: "leaveType" }],
    });
    if (!req) throw new HrmError("Leave request not found.");
    if (!isHR && req.employeeId !== employeeId)
      throw new HrmError("You can only cancel your own requests.");
    if (req.status === "pending") {
      await req.update({ status: "cancelled" }, { transaction: t });
      await auditLeave({
        leaveRequestId: req.id,
        employeeId: req.employeeId,
        action: "cancelled",
        actorId,
        oldValues: { status: "pending" },
        newValues: { status: "cancelled" },
        transaction: t,
      });
      return req;
    }
    if (req.status === "approved") {
      if (!isHR)
        throw new HrmError("Approved leave can only be cancelled by HR.");
      if (req.startDate <= todayStr())
        throw new HrmError(
          "Leave that has already started cannot be cancelled.",
        );
      if (req.leaveType.isPaid) {
        const bal = await LeaveBalance.findOne({
          where: {
            employeeId: req.employeeId,
            leaveTypeId: req.leaveTypeId,
            year: Number(req.startDate.slice(0, 4)),
          },
          transaction: t,
        });
        if (bal)
          await bal.update(
            { used: Math.max(0, bal.used - req.days) },
            { transaction: t },
          );
      }
      const linked = await Attendance.findAll({
        where: {
          employeeId: req.employeeId,
          leaveRequestId: req.id,
          status: "on_leave",
          timeIn: null,
          date: { [Op.between]: [req.startDate, req.endDate] },
        },
        ...lockOpts(t),
      });
      for (const rec of linked) {
        if (rec.statusBeforeLeave) {
          await rec.update(
            {
              status: rec.statusBeforeLeave,
              remarks: rec.remarksBeforeLeave,
              leaveRequestId: null,
              statusBeforeLeave: null,
              remarksBeforeLeave: null,
            },
            { transaction: t },
          );
        } else {
          await rec.destroy({ transaction: t });
        }
      }
      await req.update({ status: "cancelled" }, { transaction: t });
      await auditLeave({
        leaveRequestId: req.id,
        employeeId: req.employeeId,
        action: "cancelled",
        actorId,
        oldValues: { status: "approved" },
        newValues: { status: "cancelled" },
        transaction: t,
      });
      return req;
    }
    throw new HrmError("This request can no longer be cancelled.");
  });
}

export async function deleteAttendance(id, { changedBy = null } = {}) {
  return sequelize.transaction(async (t) => {
    const rec = await Attendance.findByPk(id, {
      ...lockOpts(t),
    });
    if (!rec) throw new HrmError("Attendance record not found.");
    const old = attendanceSnapshot(rec);
    await rec.destroy({ transaction: t });
    await auditAttendance({
      attendanceId: rec.id,
      employeeId: rec.employeeId,
      action: "deleted",
      changedBy,
      oldValues: old,
      newValues: null,
      transaction: t,
    });
    return true;
  });
}

/** Employee ids who are scheduled to work on `date`, and who are checked in / on leave. */
export async function dayRoster(date) {
  const emps = await Employee.findAll({
    where: { isActive: true, hireDate: { [Op.lte]: date } },
    attributes: ["id"],
  });
  const ids = emps.map((e) => e.id);
  const smap = await getScheduleMap(date, ids);
  const scheduled = ids.filter((id) =>
    isWorkday(date, (smap.get(id) || DEFAULT_SHIFT).workDays),
  );
  const recs = await Attendance.findAll({ where: { date, employeeId: ids } });
  const leaves = await LeaveRequest.findAll({
    where: {
      status: "approved",
      startDate: { [Op.lte]: date },
      endDate: { [Op.gte]: date },
      employeeId: ids,
    },
    attributes: ["employeeId"],
  });
  return {
    ids,
    scheduled,
    recs,
    checkedIn: new Set(recs.filter((r) => r.timeIn).map((r) => r.employeeId)),
    onLeave: new Set([
      ...leaves.map((l) => l.employeeId),
      ...recs.filter((r) => r.status === "on_leave").map((r) => r.employeeId),
    ]),
  };
}

// ===================== Resignation workflow =====================
// Employee submits a resignation (last working day + reason); an admin
// approves (employment ends, record deactivated) or rejects it.

export async function requestResignation({ employee, lastDay, reason }) {
  if (!employee?.id) throw new HrmError("Employee record is required.");
  if (
    !employee.isActive ||
    ["resigned", "terminated"].includes(employee.employmentStatus)
  )
    throw new HrmError("This employee record is no longer active.");
  if (employee.resignationStatus === "pending")
    throw new HrmError("A resignation request is already awaiting approval.");
  const day = String(lastDay || "").trim();
  if (!isDate(day)) throw new HrmError("Choose a valid last working day.");
  if (day < todayStr())
    throw new HrmError("The last working day cannot be in the past.");
  const why = String(reason || "").trim();
  if (!why) throw new HrmError("A reason for leaving is required.");
  if (why.length > 500)
    throw new HrmError("Reason must be 500 characters or fewer.");
  await employee.update({
    resignationDate: day,
    resignationReason: why,
    resignationStatus: "pending",
    resignationReviewedBy: null,
    resignationReviewedAt: null,
    resignationReviewRemarks: null,
  });
  return employee;
}

export async function withdrawResignation(employeeId) {
  const emp = await Employee.findByPk(employeeId);
  if (!emp) throw new HrmError("Employee not found.");
  if (emp.resignationStatus !== "pending")
    throw new HrmError("Only a pending resignation can be withdrawn.");
  await emp.update({
    resignationDate: null,
    resignationReason: null,
    resignationStatus: null,
    resignationReviewedBy: null,
    resignationReviewedAt: null,
    resignationReviewRemarks: null,
  });
  return emp;
}

export async function reviewResignation(
  employeeId,
  { action, reviewerUserId, remarks },
) {
  if (!["approved", "rejected"].includes(action))
    throw new HrmError("Invalid review action.");
  const result = await sequelize.transaction(async (t) => {
    const emp = await Employee.findByPk(employeeId, { ...lockOpts(t) });
    if (!emp) throw new HrmError("Employee not found.");
    if (emp.resignationStatus !== "pending")
      throw new HrmError("Only pending resignations can be reviewed.");
    const note = remarks ? String(remarks).trim() : null;
    if (note && note.length > 255)
      throw new HrmError("Review remarks must be 255 characters or fewer.");
    const review = {
      resignationStatus: action === "approved" ? "approved" : "rejected",
      resignationReviewedBy: reviewerUserId,
      resignationReviewedAt: new Date(),
      resignationReviewRemarks: note,
    };
    if (action === "rejected") {
      await emp.update(review, { transaction: t });
      return { emp, ended: [] };
    }
    // Approved: employment ends on the last working day (or today if past).
    const today = todayStr();
    const lastDay =
      emp.resignationDate && emp.resignationDate > today
        ? emp.resignationDate
        : today;
    const ended = [];
    const active = await Assignment.findAll({
      where: { employeeId: emp.id, status: "active" },
      transaction: t,
    });
    for (const a of active) {
      const next =
        a.startDate > lastDay
          ? { status: "cancelled", endDate: null }
          : { status: "completed", endDate: lastDay };
      await a.update(next, { transaction: t });
      ended.push({ id: a.id, employeeId: emp.id, status: next.status });
    }
    await emp.update(
      { ...review, employmentStatus: "resigned", isActive: false },
      { transaction: t },
    );
    return { emp, ended };
  });
  if (result.ended.length || result.emp.resignationStatus === "approved") {
    hrmEvents.emit("employee.statusChanged", {
      id: result.emp.id,
      to: result.emp.employmentStatus,
    });
    for (const e of result.ended) hrmEvents.emit("assignment.changed", e);
  }
  return result.emp;
}

// ===================== B. Public read-only API =====================

const empInclude = [
  { model: Department, as: "department" },
  { model: Position, as: "position" },
];
const slim = (e) => {
  const p = e.get({ plain: true });
  return {
    id: p.id,
    employeeNo: p.employeeNo,
    fullName: p.fullName,
    firstName: p.firstName,
    lastName: p.lastName,
    email: p.email,
    phone: p.phone,
    employmentStatus: p.employmentStatus,
    isActive: p.isActive,
    hireDate: p.hireDate,
    userId: p.userId,
    departmentId: p.departmentId,
    department: p.department?.name || null,
    positionId: p.positionId,
    position: p.position?.title || null,
  };
};

export async function getEmployee(id) {
  const e = await Employee.findByPk(id, { include: empInclude });
  return e ? slim(e) : null;
}
export async function listActiveEmployees({
  departmentId,
  includeInactive = false,
} = {}) {
  const rows = await Employee.findAll({
    where: {
      ...(includeInactive ? {} : { isActive: true }),
      ...(departmentId ? { departmentId } : {}),
    },
    include: empInclude,
    order: [
      ["lastName", "ASC"],
      ["firstName", "ASC"],
    ],
  });
  return rows.map(slim);
}
/** Distinct active project references HRM knows about; other modules align by projectId or projectName. */
export async function listProjectReferences() {
  const rows = await Assignment.findAll({
    where: { status: "active" },
    attributes: ["projectId", "projectName", "siteName"],
    group: ["projectId", "projectName", "siteName"],
    order: [
      ["projectName", "ASC"],
      ["siteName", "ASC"],
    ],
    raw: true,
  });
  const seen = new Map();
  for (const r of rows) {
    const projectName = normLabel(r.projectName);
    if (!projectName) continue;
    const siteName = normLabel(r.siteName);
    const key = `${r.projectId ?? "name"}|${projectName.toLowerCase()}|${(
      siteName || ""
    ).toLowerCase()}`;
    if (!seen.has(key))
      seen.set(key, { projectId: r.projectId ?? null, projectName, siteName });
  }
  return [...seen.values()].sort(
    (a, b) =>
      a.projectName.localeCompare(b.projectName) ||
      (a.siteName || "").localeCompare(b.siteName || ""),
  );
}

/** Active workers on a project; key may be projectId (number) or normalized project name. */
export async function getEmployeesByProject(key) {
  const where = {
    status: "active",
    ...(/^\d+$/.test(String(key))
      ? { projectId: Number(key) }
      : { projectName: normLabel(key) }),
  };
  const rows = await Assignment.findAll({
    where,
    include: [{ model: Employee, as: "employee", include: empInclude }],
  });
  return rows.map((a) => ({
    ...slim(a.employee),
    assignment: {
      id: a.id,
      projectId: a.projectId,
      projectName: a.projectName,
      siteName: a.siteName,
      roleOnProject: a.roleOnProject,
      startDate: a.startDate,
      endDate: a.endDate,
    },
  }));
}
export async function getHeadcountByDepartment() {
  const rows = await Employee.findAll({
    where: { isActive: true },
    attributes: ["departmentId", [fn("COUNT", col("HrmEmployee.id")), "count"]],
    group: ["departmentId"],
    include: [{ model: Department, as: "department", attributes: ["name"] }],
    raw: true,
    nest: true,
  });
  return rows.map((r) => ({
    departmentId: r.departmentId,
    department: r.department?.name || "Unassigned",
    count: Number(r.count),
  }));
}
/** Attendance facts for a period (no pay computation). */
export async function getAttendanceSummary(employeeId, from, to) {
  const recs = await Attendance.findAll({
    where: { employeeId, date: { [Op.between]: [from, to] } },
  });
  const s = {
    employeeId,
    from,
    to,
    daysPresent: 0,
    daysLate: 0,
    daysAbsent: 0,
    daysOnLeave: 0,
    minutesLate: 0,
    hoursWorked: 0,
  };
  for (const r of recs) {
    if (r.status === "present" || r.status === "half_day") s.daysPresent++;
    else if (r.status === "late") {
      s.daysLate++;
    } else if (r.status === "absent") s.daysAbsent++;
    else if (r.status === "on_leave") s.daysOnLeave++;
    s.minutesLate += r.minutesLate;
    s.hoursWorked += hoursBetween(r.timeIn, r.timeOut);
  }
  s.hoursWorked = Math.round(s.hoursWorked * 100) / 100;
  return s;
}

/** Daily attendance trend using the schedule effective on each date. */
export async function getAttendanceTrend(from, to) {
  const emps = await Employee.findAll({
    where: {
      hireDate: { [Op.lte]: to },
      [Op.or]: [{ isActive: true }, { updatedAt: { [Op.gte]: from } }],
    },
    attributes: ["id", "hireDate"],
  });
  const ids = emps.map((e) => e.id);
  const [recs, scheduleRows] = await Promise.all([
    Attendance.findAll({
      where: { employeeId: ids, date: { [Op.between]: [from, to] } },
    }),
    scheduleRowsForEmployees(ids, from, to),
  ]);
  const recsByDate = new Map();
  for (const row of recs) {
    const r = row.get({ plain: true });
    const list = recsByDate.get(r.date);
    if (list) list.push(r);
    else recsByDate.set(r.date, [r]);
  }
  return eachDate(from, to).map((d) => {
    const eligible = emps.filter((e) => e.hireDate <= d);
    const idSet = new Set(eligible.map((e) => e.id));
    let scheduled = 0,
      present = 0,
      late = 0,
      leave = 0;
    for (const e of eligible) {
      const rows = scheduleRows.get(e.id) || [];
      if (isWorkday(d, scheduleForDate(rows, d).workDays)) scheduled++;
    }
    for (const r of recsByDate.get(d) || []) {
      if (!idSet.has(r.employeeId)) continue;
      if (r.status === "present" || r.status === "half_day") present++;
      else if (r.status === "late") late++;
      else if (r.status === "on_leave") leave++;
    }
    return {
      date: d,
      scheduled,
      present,
      late,
      leave,
      absent: Math.max(0, scheduled - present - late - leave),
    };
  });
}

/** Per-employee attendance aggregates for reports, using per-date schedules. */
export async function getAttendanceReportRows(employees, from, to) {
  const list = employees.map((e) => ({
    id: e.id,
    hireDate: e.hireDate,
  }));
  const ids = list.map((e) => e.id);
  if (!ids.length) return new Map();
  const [recs, scheduleRows] = await Promise.all([
    Attendance.findAll({
      where: { employeeId: ids, date: { [Op.between]: [from, to] } },
    }),
    scheduleRowsForEmployees(ids, from, to),
  ]);
  const end = to < todayStr() ? to : todayStr();
  const recsByEmp = new Map();
  for (const row of recs) {
    const r = row.get({ plain: true });
    const arr = recsByEmp.get(r.employeeId);
    if (arr) arr.push(r);
    else recsByEmp.set(r.employeeId, [r]);
  }
  const map = new Map();
  for (const e of list) {
    const rows = scheduleRows.get(e.id) || [];
    const start = e.hireDate > from ? e.hireDate : from;
    const scheduledDays =
      start <= end ? countWorkdaysWithRows(rows, start, end) : 0;
    const r = recsByEmp.get(e.id) || [];
    const present = r.filter(
      (x) => x.status === "present" || x.status === "half_day",
    ).length;
    const late = r.filter((x) => x.status === "late").length;
    const onLeave = r.filter((x) => x.status === "on_leave").length;
    map.set(e.id, {
      scheduledDays,
      present,
      late,
      onLeave,
      absent: Math.max(0, scheduledDays - present - late - onLeave),
      minutesLate: Math.max(
        0,
        r.reduce((s, x) => s + Math.max(0, Number(x.minutesLate) || 0), 0),
      ),
      hoursWorked: Math.max(
        0,
        Math.round(
          r.reduce((s, x) => s + hoursBetween(x.timeIn, x.timeOut), 0) * 100,
        ) / 100,
      ),
    });
  }
  return map;
}

/**
 * Period facts for PayrollMS (read-only, no pay computation, no salary data).
 * One row per employee who was employed during the period.
 */
export async function getPayrollInputs(from, to, { departmentId } = {}) {
  if (!isDate(from) || !isDate(to) || to < from)
    throw new HrmError("Provide a valid from/to date range.");
  const emps = await Employee.findAll({
    where: {
      hireDate: { [Op.lte]: to },
      ...(departmentId ? { departmentId } : {}),
      [Op.or]: [{ isActive: true }, { updatedAt: { [Op.gte]: from } }],
    },
    include: empInclude,
    order: [
      ["lastName", "ASC"],
      ["firstName", "ASC"],
    ],
  });
  const ids = emps.map((e) => e.id);
  const [recs, leaves, scheduleRows] = await Promise.all([
    Attendance.findAll({
      where: { employeeId: ids, date: { [Op.between]: [from, to] } },
    }),
    LeaveRequest.findAll({
      where: {
        employeeId: ids,
        status: "approved",
        startDate: { [Op.lte]: to },
        endDate: { [Op.gte]: from },
      },
      include: [{ model: LeaveType, as: "leaveType" }],
    }),
    scheduleRowsForEmployees(ids, from, to),
  ]);
  const end = to < todayStr() ? to : todayStr();
  return Promise.all(
    emps.map(async (e) => {
      const r = recs.filter((x) => x.employeeId === e.id);
      const rows = scheduleRows.get(e.id) || [];
      const start = e.hireDate > from ? e.hireDate : from;
      const scheduledDays =
        start <= end ? countWorkdaysWithRows(rows, start, end) : 0;
      let paid = 0,
        unpaid = 0;
      for (const l of leaves.filter((x) => x.employeeId === e.id)) {
        const leaveStart = l.startDate > start ? l.startDate : start;
        const leaveEnd = l.endDate < end ? l.endDate : end;
        if (leaveStart <= leaveEnd) {
          const n = countWorkdaysWithRows(rows, leaveStart, leaveEnd);
          if (l.leaveType.isPaid) paid += n;
          else unpaid += n;
        }
      }
      const presentFull = r.filter((x) => x.status === "present").length;
      const half = r.filter((x) => x.status === "half_day").length;
      const late = r.filter((x) => x.status === "late").length;
      // Half-day handling: a half_day counts as 0.5 worked day; the remaining
      // 0.5 is treated as an absence equivalent for Payroll to price.
      const workedDayEquivalent =
        Math.round((presentFull + late + half / 2) * 100) / 100;
      const daysAbsent = Math.max(
        0,
        Math.round(
          (scheduledDays - workedDayEquivalent - paid - unpaid) * 100,
        ) / 100,
      );
      return {
        employeeId: e.id,
        employeeNo: e.employeeNo,
        fullName: e.fullName,
        userId: e.userId,
        department: e.department?.name || null,
        position: e.position?.title || null,
        employmentStatus: e.employmentStatus,
        isActive: e.isActive,
        hireDate: e.hireDate,
        from,
        to,
        scheduledDays,
        daysPresent: presentFull + half,
        daysLate: late,
        halfDays: half,
        workedDayEquivalent,
        paidLeaveDays: paid,
        unpaidLeaveDays: unpaid,
        daysAbsent,
        minutesLate: Math.max(
          0,
          r.reduce((s, x) => s + Math.max(0, Number(x.minutesLate) || 0), 0),
        ),
        hoursWorked: Math.max(
          0,
          Math.round(
            r.reduce((s, x) => s + hoursBetween(x.timeIn, x.timeOut), 0) * 100,
          ) / 100,
        ),
      };
    }),
  );
}
