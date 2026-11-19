import fs from "fs";
import path from "path";
import crypto from "crypto";
import bcrypt from "bcrypt";
import multer from "multer";
import { Op } from "sequelize";
import {
  sequelize,
  Department,
  Position,
  Employee,
  EmployeeDocument,
  WorkSchedule,
  Attendance,
  LeaveBalance,
  LeaveType,
  Assignment,
  User,
} from "../../models/hrm/index.js";
import { HrmError, todayStr } from "../../models/hrm/services/hrmUtils.js";
import {
  nextEmployeeNo,
  getSchedule,
  getAttendanceSummary,
  ensureBalances,
  hrmEvents,
  requestResignation,
  withdrawResignation,
  reviewResignation,
} from "../../models/hrm/services/hrmService.js";
import { safe, back, plain, pick, bool, intOrNull } from "./_shared.js";
import { PASSWORD_RE, PASSWORD_RULES } from "../validators.js";

const PAGE = 12;
const STATUSES = [
  "probationary",
  "regular",
  "contractual",
  "project-based",
  "resigned",
  "terminated",
];
const DOC_DIR = path.join(
  process.cwd(),
  "models",
  "hrm",
  "uploads",
  "hrm-docs",
);
fs.mkdirSync(DOC_DIR, { recursive: true });

export const upload = multer({
  storage: multer.diskStorage({
    destination: DOC_DIR,
    filename: (req, file, cb) =>
      cb(
        null,
        crypto.randomUUID() + path.extname(file.originalname).toLowerCase(),
      ),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const okExt = /\.(pdf|jpe?g|png|docx?)$/i.test(file.originalname);
    // some browsers send octet-stream for Office files, so allow it when the
    // extension already matches; otherwise require a known document MIME type.
    const okMime =
      [
        "application/pdf",
        "image/jpeg",
        "image/png",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "",
        "application/octet-stream",
      ].includes(file.mimetype) || !file.mimetype;
    return okExt && okMime
      ? cb(null, true)
      : cb(new Error("Only PDF, JPG, PNG or Word files are allowed."));
  },
});
export const uploadDoc = (req, res, next) =>
  upload.single("file")(req, res, (err) => {
    if (err) {
      req.flash(
        "error_msg",
        err.code === "LIMIT_FILE_SIZE"
          ? "File is larger than 5 MB."
          : err.message,
      );
      return res.redirect(back(req));
    }
    next();
  });

const startsWith = (buf, bytes, offset = 0) =>
  bytes.every((b, i) => buf[offset + i] === b);

/** Verifies the file signature; client MIME types and extensions are spoofable. */
async function documentSignatureOk(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  const fh = await fs.promises.open(file.path, "r");
  try {
    const buf = Buffer.alloc(8);
    await fh.read(buf, 0, 8, 0);
    if (ext === ".pdf")
      return buf.subarray(0, 5).toString("latin1") === "%PDF-";
    if (ext === ".jpg" || ext === ".jpeg")
      return startsWith(buf, [0xff, 0xd8, 0xff]);
    if (ext === ".png")
      return startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (ext === ".docx")
      return buf[0] === 0x50 && buf[1] === 0x4b && buf[2] >= 3 && buf[2] <= 7;
    if (ext === ".doc")
      return startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    return false;
  } finally {
    await fh.close();
  }
}

const include = [
  { model: Department, as: "department" },
  { model: Position, as: "position" },
];

export const index = safe(async (req, res) => {
  const { q = "", departmentId = "", status = "", active = "1" } = req.query;
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const where = {};
  const tokens = q.trim().split(/\s+/).filter(Boolean);
  if (tokens.length)
    where[Op.and] = tokens.map((t) => ({
      [Op.or]: [
        "firstName",
        "middleName",
        "lastName",
        "employeeNo",
        "email",
        "phone",
      ].map((f) => ({ [f]: { [Op.like]: `%${t}%` } })),
    }));
  if (departmentId) where.departmentId = departmentId;
  if (status) where.employmentStatus = status;
  if (active !== "") where.isActive = active === "1";
  const { rows, count } = await Employee.findAndCountAll({
    where,
    include,
    distinct: true,
    order: [
      ["lastName", "ASC"],
      ["firstName", "ASC"],
    ],
    limit: PAGE,
    offset: (page - 1) * PAGE,
  });
  const pages = Math.max(1, Math.ceil(count / PAGE));
  const qs = new URLSearchParams({
    q,
    departmentId,
    status,
    active,
  }).toString();
  res.render("hrm/employees/index", {
    title: "Employees",
    active: "employees",
    rows: plain(rows),
    count,
    page,
    pages,
    qs,
    prev: page > 1 ? page - 1 : null,
    next: page < pages ? page + 1 : null,
    q,
    departmentId,
    status,
    activeFilter: active,
    statuses: STATUSES,
    departments: plain(await Department.findAll({ order: [["name", "ASC"]] })),
  });
});

async function formData(excludeId = null, linkedUserId = null) {
  const [departments, positions, supervisors, users, linked] =
    await Promise.all([
      Department.findAll({
        where: { isActive: true },
        order: [["name", "ASC"]],
      }),
      Position.findAll({
        where: { isActive: true },
        order: [["title", "ASC"]],
      }),
      Employee.findAll({
        where: {
          isActive: true,
          ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}),
        },
        order: [["lastName", "ASC"]],
      }),
      User.findAll({
        attributes: ["id", "name", "email", "role"],
        order: [["name", "ASC"]],
      }),
      Employee.findAll({
        where: { userId: { [Op.ne]: null } },
        attributes: ["userId"],
      }),
    ]);
  const taken = new Set(linked.map((e) => e.userId));
  return {
    departments: plain(departments),
    positions: plain(positions),
    supervisors: plain(supervisors),
    statuses: STATUSES,
    users: plain(users)
      .filter((u) => !taken.has(u.id) || u.id === linkedUserId)
      .map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role })),
  };
}

export const newForm = safe(async (req, res) => {
  res.render("hrm/employees/form", {
    title: "Add Employee",
    active: "employees",
    isEdit: false,
    employee: {
      hireDate: todayStr(),
      employmentStatus: "probationary",
      isActive: true,
    },
    ...(await formData()),
  });
});
export const editForm = safe(async (req, res) => {
  const e = await Employee.findByPk(req.params.id);
  if (!e) {
    req.flash("error_msg", "Employee not found.");
    return res.redirect("/hrm/employees");
  }
  res.render("hrm/employees/form", {
    title: "Edit Employee",
    active: "employees",
    isEdit: true,
    employee: plain(e),
    ...(await formData(e.id, e.userId)),
  });
});

const FIELDS = [
  "firstName",
  "middleName",
  "lastName",
  "suffix",
  "birthDate",
  "sex",
  "civilStatus",
  "phone",
  "email",
  "address",
  "emergencyName",
  "emergencyPhone",
  "emergencyRelation",
  "hireDate",
  "employmentStatus",
];
const NULLABLE = [
  "middleName",
  "suffix",
  "birthDate",
  "sex",
  "civilStatus",
  "phone",
  "email",
  "address",
  "emergencyName",
  "emergencyPhone",
  "emergencyRelation",
];

async function buildData(req, current = null) {
  const b = req.body;
  const data = pick(b, FIELDS, NULLABLE);
  if (!STATUSES.includes(data.employmentStatus))
    throw new HrmError("Choose a valid employment status.");
  data.departmentId = intOrNull(b.departmentId);
  data.positionId = intOrNull(b.positionId);
  data.supervisorId = intOrNull(b.supervisorId);
  if (current && data.supervisorId === current.id)
    throw new HrmError("An employee cannot supervise themselves.");
  if (data.positionId) {
    const pos = await Position.findByPk(data.positionId);
    if (!pos) throw new HrmError("Selected position does not exist.");
    if (data.departmentId && pos.departmentId !== data.departmentId)
      throw new HrmError(
        "The selected position does not belong to the selected department.",
      );
    if (!data.departmentId) data.departmentId = pos.departmentId;
  }
  if (req.hrm.isHR) {
    data.userId = intOrNull(b.userId);
    if (data.userId) {
      const user = await User.findByPk(data.userId);
      if (!user) throw new HrmError("Selected user account does not exist.");
      const other = await Employee.findOne({
        where: {
          userId: data.userId,
          ...(current ? { id: { [Op.ne]: current.id } } : {}),
        },
        attributes: ["id", "employeeNo"],
      });
      if (other)
        throw new HrmError(
          `That account is already linked to employee ${other.employeeNo}.`,
        );
    }
  }
  data.isActive =
    !["resigned", "terminated"].includes(data.employmentStatus) &&
    (b.isActive === undefined ? true : bool(b.isActive));
  return data;
}

export const create = safe(async (req, res) => {
  const data = await buildData(req);
  let emp;
  for (let i = 0; i < 3; i++) {
    // retry if two HR users generate the same number at once
    try {
      emp = await Employee.create({
        ...data,
        employeeNo: await nextEmployeeNo(),
      });
      break;
    } catch (e) {
      if (
        e.name !== "SequelizeUniqueConstraintError" ||
        e.errors?.[0]?.path !== "employeeNo" ||
        i === 2
      )
        throw e;
    }
  }
  hrmEvents.emit("employee.created", {
    id: emp.id,
    employeeNo: emp.employeeNo,
  });
  req.flash(
    "success_msg",
    `Employee ${emp.fullName} registered with ID ${emp.employeeNo}.`,
  );
  res.redirect(`/hrm/employees/${emp.id}`);
});

export const update = safe(async (req, res) => {
  const emp = await Employee.findByPk(req.params.id);
  if (!emp) {
    req.flash("error_msg", "Employee not found.");
    return res.redirect("/hrm/employees");
  }
  const before = emp.employmentStatus;
  await emp.update(await buildData(req, emp));
  hrmEvents.emit("employee.updated", { id: emp.id });
  if (before !== emp.employmentStatus)
    hrmEvents.emit("employee.statusChanged", {
      id: emp.id,
      from: before,
      to: emp.employmentStatus,
    });
  req.flash("success_msg", "Employee updated.");
  res.redirect(`/hrm/employees/${emp.id}`);
});

/** "Delete" = deactivate, so attendance/leave history is preserved. */
export const deactivate = safe(async (req, res) => {
  const emp = await Employee.findByPk(req.params.id);
  if (!emp) return res.redirect("/hrm/employees");
  const today = todayStr();
  const ended = [];
  await sequelize.transaction(async (t) => {
    await emp.update({ isActive: false }, { transaction: t });
    const active = await Assignment.findAll({
      where: { employeeId: emp.id, status: "active" },
      transaction: t,
    });
    for (const a of active) {
      const next =
        a.startDate > today
          ? { status: "cancelled", endDate: null }
          : { status: "completed", endDate: today };
      await a.update(next, { transaction: t });
      ended.push({ id: a.id, employeeId: emp.id, status: next.status });
    }
  });
  hrmEvents.emit("employee.statusChanged", {
    id: emp.id,
    to: emp.employmentStatus,
  });
  for (const e of ended) hrmEvents.emit("assignment.changed", e);
  req.flash(
    "success_msg",
    `${emp.fullName} was deactivated. Records are kept for history.`,
  );
  res.redirect("/hrm/employees");
});
export const reactivate = safe(async (req, res) => {
  const emp = await Employee.findByPk(req.params.id);
  if (emp) {
    const nextStatus = ["resigned", "terminated"].includes(emp.employmentStatus)
      ? "probationary"
      : emp.employmentStatus;
    await emp.update({ isActive: true, employmentStatus: nextStatus });
    hrmEvents.emit("employee.statusChanged", { id: emp.id, to: nextStatus });
  }
  req.flash("success_msg", "Employee reactivated.");
  res.redirect(back(req));
});

export const me = (req, res) =>
  res.redirect(
    req.hrm.employee ? `/hrm/employees/${req.hrm.employee.id}` : "/hrm",
  );

export const show = safe(async (req, res) => {
  const id = Number(req.params.id);
  if (!req.hrm.isHR && req.hrm.employee?.id !== id)
    return res
      .status(403)
      .render("hrm/403", { title: "Access denied", active: "" });
  const emp = await Employee.findByPk(id, {
    include: [
      ...include,
      { model: Employee, as: "supervisor" },
      { model: User, as: "user", attributes: ["name", "email", "role"] },
    ],
  });
  if (!emp) {
    req.flash("error_msg", "Employee not found.");
    return res.redirect("/hrm");
  }
  const today = todayStr(),
    year = Number(today.slice(0, 4));
  await ensureBalances(year, [id]);
  const [docs, schedule, assignments, balances, recent, summary] =
    await Promise.all([
      EmployeeDocument.findAll({
        where: { employeeId: id },
        order: [["createdAt", "DESC"]],
      }),
      getSchedule(id, today),
      Assignment.findAll({
        where: { employeeId: id },
        order: [
          ["status", "ASC"],
          ["startDate", "DESC"],
        ],
        limit: 8,
      }),
      LeaveBalance.findAll({
        where: { employeeId: id, year },
        include: [{ model: LeaveType, as: "leaveType" }],
      }),
      Attendance.findAll({
        where: { employeeId: id },
        order: [["date", "DESC"]],
        limit: 7,
      }),
      getAttendanceSummary(id, `${today.slice(0, 7)}-01`, today),
    ]);
  res.render("hrm/employees/show", {
    title: emp.fullName,
    active: req.hrm.isHR ? "employees" : "profile",
    employee: plain(emp),
    docs: plain(docs),
    schedule,
    assignments: plain(assignments),
    balances: plain(balances).map((b) => ({
      ...b,
      remaining: b.entitled - b.used,
    })),
    recent: plain(recent),
    summary,
    year,
    today: todayStr(),
    isSelf: req.hrm.employee?.id === id,
  });
});

export const addDocument = safe(async (req, res) => {
  const id = Number(req.params.id);
  if (!req.file) throw new HrmError("Please choose a file to upload.");
  if (!(await documentSignatureOk(req.file))) {
    fs.unlink(req.file.path, () => {});
    throw new HrmError("File content does not match an allowed document type.");
  }
  const b = pick(req.body, ["docType", "title"]);
  if (!(await Employee.findByPk(id))) {
    fs.unlink(req.file.path, () => {});
    throw new HrmError("Employee not found.");
  }
  await EmployeeDocument.create({
    employeeId: id,
    docType: b.docType || "Other",
    title: b.title || req.file.originalname,
    originalName: req.file.originalname,
    filePath: req.file.filename,
    mimeType: req.file.mimetype,
    size: req.file.size,
    uploadedBy: req.hrm.user.id,
  });
  req.flash("success_msg", "Document uploaded.");
  res.redirect(`/hrm/employees/${id}#documents`);
});
export const downloadDocument = safe(async (req, res) => {
  const d = await EmployeeDocument.findByPk(req.params.docId);
  if (!d || (!req.hrm.isHR && req.hrm.employee?.id !== d.employeeId))
    return res
      .status(404)
      .render("hrm/403", { title: "Not found", active: "" });
  res.download(path.join(DOC_DIR, path.basename(d.filePath)), d.originalName);
});
export const deleteDocument = safe(async (req, res) => {
  const d = await EmployeeDocument.findByPk(req.params.docId);
  if (d) {
    fs.unlink(path.join(DOC_DIR, path.basename(d.filePath)), () => {});
    await d.destroy();
  }
  req.flash("success_msg", "Document removed.");
  res.redirect(back(req));
});

// ---- Self-service password change (any signed-in user) ----
export const changePasswordForm = (req, res) =>
  res.render("hrm/password", { title: "Change Password", active: "" });
export const changePassword = safe(async (req, res) => {
  const backTo = req.hrm.employee
    ? `/hrm/employees/${req.hrm.employee.id}`
    : "/hrm";
  const backToForm = "/hrm/me/password";
  const user = await User.findByPk(req.hrm.user.id);
  if (!user) throw new HrmError("Account not found.");
  if (
    !(await bcrypt.compare(
      String(req.body.currentPassword || ""),
      user.password,
    ))
  ) {
    req.flash("error_msg", "Current password is incorrect.");
    return res.redirect(backToForm);
  }
  const password = String(req.body.password || "");
  const errors = [];
  if (!PASSWORD_RE.test(password)) errors.push(PASSWORD_RULES);
  else if (password !== String(req.body.confirmPassword || ""))
    errors.push("Passwords do not match.");
  if (errors.length) {
    req.flash("error_msg", errors.join(" "));
    return res.redirect(backToForm);
  }
  await user.update({ password: await bcrypt.hash(password, 10) });
  req.flash("success_msg", "Password changed successfully.");
  res.redirect(backTo);
});

// ---- Resignation: employee submits, admin approves/rejects ----
const selfOnly = (req, res, id) => {
  if (req.hrm.employee?.id === id) return false;
  res.status(403).render("hrm/403", { title: "Access denied", active: "" });
  return true;
};

export const submitResignation = safe(async (req, res) => {
  const id = Number(req.params.id);
  if (selfOnly(req, res, id)) return;
  const b = pick(req.body, ["lastDay", "reason"]);
  await requestResignation({
    employee: req.hrm.employee,
    lastDay: b.lastDay,
    reason: b.reason,
  });
  req.flash(
    "success_msg",
    "Resignation submitted — waiting for admin approval.",
  );
  res.redirect(`/hrm/employees/${id}#resignation`);
});

export const cancelResignation = safe(async (req, res) => {
  const id = Number(req.params.id);
  if (selfOnly(req, res, id)) return;
  await withdrawResignation(id);
  req.flash("success_msg", "Resignation request withdrawn.");
  res.redirect(`/hrm/employees/${id}#resignation`);
});

export const resignationIndex = safe(async (req, res) => {
  const rows = await Employee.findAll({
    where: { resignationStatus: { [Op.ne]: null } },
    include: [
      ...include,
      { model: User, as: "resignationReviewer", attributes: ["name"] },
    ],
    order: [
      [
        Employee.sequelize.literal(
          "FIELD(HrmEmployee.resignationStatus,'pending','rejected','approved')",
        ),
        "ASC",
      ],
      ["resignationReviewedAt", "DESC"],
    ],
  });
  res.render("hrm/resignations/index", {
    title: "Resignations",
    active: "resignations",
    rows: plain(rows).map((r) => ({
      ...r,
      canReview: r.resignationStatus === "pending",
    })),
  });
});

export const approveResignation = safe(async (req, res) => {
  const emp = await reviewResignation(Number(req.params.id), {
    action: "approved",
    reviewerUserId: req.hrm.user.id,
    remarks: req.body.remarks,
  });
  req.flash(
    "success_msg",
    `${emp.fullName} marked as resigned (last day ${emp.resignationDate}).`,
  );
  res.redirect(back(req, "/hrm/resignations"));
});

export const rejectResignation = safe(async (req, res) => {
  const emp = await reviewResignation(Number(req.params.id), {
    action: "rejected",
    reviewerUserId: req.hrm.user.id,
    remarks: req.body.remarks,
  });
  req.flash("success_msg", `Resignation request for ${emp.fullName} rejected.`);
  res.redirect(back(req, "/hrm/resignations"));
});
