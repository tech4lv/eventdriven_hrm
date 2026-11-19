/*
  RektaBuild HRM models. All tables are prefixed "hrm_" so they never collide
  with tables owned by Supply, Accounting, Inventory or Payroll modules.
  The only shared table referenced is "Users" (authentication).
*/
import { DataTypes as D } from "sequelize";
import { sequelize, User } from "../userModel.js";

const dec = (name) => ({
  type: D.DECIMAL(6, 1),
  allowNull: false,
  defaultValue: 0,
  get() {
    return Number(this.getDataValue(name));
  },
});

export const Department = sequelize.define(
  "HrmDepartment",
  {
    name: {
      type: D.STRING(100),
      allowNull: false,
      unique: true,
      validate: { notEmpty: true },
    },
    code: { type: D.STRING(20), allowNull: true, unique: true },
    description: { type: D.TEXT, allowNull: true },
    headEmployeeId: { type: D.INTEGER, allowNull: true }, // soft reference (avoids circular FK)
    isActive: { type: D.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { tableName: "hrm_departments" },
);

export const Position = sequelize.define(
  "HrmPosition",
  {
    title: {
      type: D.STRING(100),
      allowNull: false,
      validate: { notEmpty: true },
    },
    description: { type: D.TEXT, allowNull: true },
    isActive: { type: D.BOOLEAN, allowNull: false, defaultValue: true },
  },
  {
    tableName: "hrm_positions",
    indexes: [{ unique: true, fields: ["title", "departmentId"] }],
  },
);

export const Employee = sequelize.define(
  "HrmEmployee",
  {
    employeeNo: { type: D.STRING(20), allowNull: false, unique: true },
    userId: { type: D.INTEGER, allowNull: true, unique: true },
    firstName: {
      type: D.STRING(60),
      allowNull: false,
      validate: { notEmpty: true },
    },
    middleName: { type: D.STRING(60), allowNull: true },
    lastName: {
      type: D.STRING(60),
      allowNull: false,
      validate: { notEmpty: true },
    },
    suffix: { type: D.STRING(10), allowNull: true },
    birthDate: { type: D.DATEONLY, allowNull: true },
    sex: { type: D.ENUM("male", "female"), allowNull: true },
    civilStatus: {
      type: D.ENUM("single", "married", "widowed", "separated"),
      allowNull: true,
    },
    phone: { type: D.STRING(30), allowNull: true },
    email: {
      type: D.STRING(120),
      allowNull: true,
      validate: { isEmail: { msg: "Enter a valid email address." } },
    },
    address: { type: D.STRING(255), allowNull: true },
    emergencyName: { type: D.STRING(100), allowNull: true },
    emergencyPhone: { type: D.STRING(30), allowNull: true },
    emergencyRelation: { type: D.STRING(40), allowNull: true },
    hireDate: { type: D.DATEONLY, allowNull: false },
    employmentStatus: {
      type: D.ENUM(
        "probationary",
        "regular",
        "contractual",
        "project-based",
        "resigned",
        "terminated",
      ),
      allowNull: false,
      defaultValue: "probationary",
    },
    isActive: { type: D.BOOLEAN, allowNull: false, defaultValue: true },
    // Resignation request (employee submits, admin approves/rejects)
    resignationDate: { type: D.DATEONLY, allowNull: true }, // last working day
    resignationReason: { type: D.STRING(500), allowNull: true },
    resignationStatus: {
      type: D.ENUM("pending", "approved", "rejected"),
      allowNull: true,
    },
    resignationReviewedBy: { type: D.INTEGER, allowNull: true },
    resignationReviewedAt: { type: D.DATE, allowNull: true },
    resignationReviewRemarks: { type: D.STRING(255), allowNull: true },
    fullName: {
      type: D.VIRTUAL,
      get() {
        return [this.firstName, this.middleName, this.lastName, this.suffix]
          .filter(Boolean)
          .join(" ");
      },
    },
  },
  { tableName: "hrm_employees" },
);

export const EmployeeDocument = sequelize.define(
  "HrmEmployeeDocument",
  {
    docType: { type: D.STRING(40), allowNull: false },
    title: { type: D.STRING(150), allowNull: false },
    originalName: { type: D.STRING(255), allowNull: false },
    filePath: { type: D.STRING(255), allowNull: false },
    mimeType: { type: D.STRING(100), allowNull: true },
    size: { type: D.INTEGER, allowNull: true },
  },
  { tableName: "hrm_employee_documents" },
);

export const WorkSchedule = sequelize.define(
  "HrmWorkSchedule",
  {
    workDays: {
      type: D.STRING(20),
      allowNull: false,
      defaultValue: "1,2,3,4,5,6",
    }, // 0=Sun..6=Sat
    shiftStart: { type: D.TIME, allowNull: false, defaultValue: "08:00:00" },
    shiftEnd: { type: D.TIME, allowNull: false, defaultValue: "17:00:00" },
    effectiveFrom: { type: D.DATEONLY, allowNull: false },
    effectiveTo: { type: D.DATEONLY, allowNull: true },
  },
  {
    tableName: "hrm_work_schedules",
    indexes: [{ fields: ["employeeId", "effectiveFrom"] }],
  },
);

export const Attendance = sequelize.define(
  "HrmAttendance",
  {
    date: { type: D.DATEONLY, allowNull: false },
    timeIn: { type: D.TIME, allowNull: true },
    timeOut: { type: D.TIME, allowNull: true },
    status: {
      type: D.ENUM("present", "late", "absent", "on_leave", "half_day"),
      allowNull: false,
      defaultValue: "present",
    },
    minutesLate: { type: D.INTEGER, allowNull: false, defaultValue: 0 },
    remarks: { type: D.STRING(255), allowNull: true },
    leaveRequestId: { type: D.INTEGER, allowNull: true }, // soft reference to the leave that marked this day
    statusBeforeLeave: { type: D.STRING(20), allowNull: true },
    remarksBeforeLeave: { type: D.STRING(255), allowNull: true },
  },
  {
    tableName: "hrm_attendance",
    indexes: [{ unique: true, fields: ["employeeId", "date"] }],
  },
);

export const AttendanceAudit = sequelize.define(
  "HrmAttendanceAudit",
  {
    attendanceId: { type: D.INTEGER, allowNull: true }, // soft reference
    action: { type: D.STRING(40), allowNull: false },
    oldValues: { type: D.JSON, allowNull: true },
    newValues: { type: D.JSON, allowNull: true },
  },
  {
    tableName: "hrm_attendance_audit",
    indexes: [
      { fields: ["employeeId", "createdAt"] },
      { fields: ["attendanceId"] },
    ],
  },
);

export const LeaveType = sequelize.define(
  "HrmLeaveType",
  {
    name: {
      type: D.STRING(60),
      allowNull: false,
      unique: true,
      validate: { notEmpty: true },
    },
    description: { type: D.STRING(255), allowNull: true },
    defaultDays: dec("defaultDays"),
    isPaid: { type: D.BOOLEAN, allowNull: false, defaultValue: true },
    isActive: { type: D.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { tableName: "hrm_leave_types" },
);

export const LeaveBalance = sequelize.define(
  "HrmLeaveBalance",
  {
    year: { type: D.INTEGER, allowNull: false },
    entitled: dec("entitled"),
    used: dec("used"),
  },
  {
    tableName: "hrm_leave_balances",
    indexes: [{ unique: true, fields: ["employeeId", "leaveTypeId", "year"] }],
  },
);

export const LeaveRequest = sequelize.define(
  "HrmLeaveRequest",
  {
    startDate: { type: D.DATEONLY, allowNull: false },
    endDate: { type: D.DATEONLY, allowNull: false },
    days: dec("days"),
    reason: { type: D.STRING(500), allowNull: true },
    status: {
      type: D.ENUM("pending", "approved", "rejected", "cancelled"),
      allowNull: false,
      defaultValue: "pending",
    },
    reviewedAt: { type: D.DATE, allowNull: true },
    reviewRemarks: { type: D.STRING(255), allowNull: true },
  },
  {
    tableName: "hrm_leave_requests",
    indexes: [
      { fields: ["employeeId", "status", "startDate", "endDate"] },
      { fields: ["status", "startDate", "endDate"] },
    ],
  },
);

export const LeaveAudit = sequelize.define(
  "HrmLeaveAudit",
  {
    leaveRequestId: { type: D.INTEGER, allowNull: false }, // soft reference
    action: { type: D.STRING(40), allowNull: false },
    oldValues: { type: D.JSON, allowNull: true },
    newValues: { type: D.JSON, allowNull: true },
  },
  {
    tableName: "hrm_leave_audit",
    indexes: [
      { fields: ["employeeId", "createdAt"] },
      { fields: ["leaveRequestId"] },
    ],
  },
);

export const Assignment = sequelize.define(
  "HrmProjectAssignment",
  {
    projectId: { type: D.INTEGER, allowNull: true }, // reference to the module that owns projects (no FK yet)
    projectName: {
      type: D.STRING(150),
      allowNull: false,
      validate: { notEmpty: true },
    },
    siteName: { type: D.STRING(150), allowNull: true },
    roleOnProject: { type: D.STRING(100), allowNull: true },
    startDate: { type: D.DATEONLY, allowNull: false },
    endDate: { type: D.DATEONLY, allowNull: true },
    status: {
      type: D.ENUM("active", "completed", "cancelled"),
      allowNull: false,
      defaultValue: "active",
    },
    notes: { type: D.STRING(255), allowNull: true },
  },
  {
    tableName: "hrm_project_assignments",
    indexes: [
      { fields: ["employeeId", "status"] },
      { fields: ["status", "startDate"] },
      { fields: ["projectName"] },
    ],
  },
);

// ---- Associations -------------------------------------------------------
const fk = (name, allowNull = false) => ({ name, allowNull });

Department.hasMany(Position, {
  foreignKey: fk("departmentId"),
  as: "positions",
  onDelete: "RESTRICT",
});
Position.belongsTo(Department, {
  foreignKey: fk("departmentId"),
  as: "department",
});

Department.hasMany(Employee, {
  foreignKey: fk("departmentId", true),
  as: "employees",
  onDelete: "RESTRICT",
});
Employee.belongsTo(Department, {
  foreignKey: fk("departmentId", true),
  as: "department",
});
Position.hasMany(Employee, {
  foreignKey: fk("positionId", true),
  as: "employees",
  onDelete: "RESTRICT",
});
Employee.belongsTo(Position, {
  foreignKey: fk("positionId", true),
  as: "position",
});
Employee.belongsTo(Employee, {
  foreignKey: fk("supervisorId", true),
  as: "supervisor",
  onDelete: "SET NULL",
});
Employee.belongsTo(User, {
  foreignKey: "userId",
  as: "user",
  onDelete: "SET NULL",
});
Employee.belongsTo(User, {
  foreignKey: fk("resignationReviewedBy", true),
  as: "resignationReviewer",
  onDelete: "SET NULL",
});
User.hasMany(Employee, { foreignKey: "userId", as: "employees" });

const childOf = (Child, as) => {
  Employee.hasMany(Child, {
    foreignKey: fk("employeeId"),
    as,
    onDelete: "RESTRICT",
  });
  Child.belongsTo(Employee, { foreignKey: fk("employeeId"), as: "employee" });
};
childOf(EmployeeDocument, "documents");
childOf(WorkSchedule, "schedules");
childOf(Attendance, "attendance");
childOf(AttendanceAudit, "attendanceAudits");
childOf(LeaveBalance, "leaveBalances");
childOf(LeaveRequest, "leaveRequests");
childOf(LeaveAudit, "leaveAudits");
childOf(Assignment, "assignments");

EmployeeDocument.belongsTo(User, {
  foreignKey: fk("uploadedBy", true),
  as: "uploader",
  onDelete: "SET NULL",
});
LeaveType.hasMany(LeaveBalance, {
  foreignKey: fk("leaveTypeId"),
  as: "balances",
  onDelete: "RESTRICT",
});
LeaveBalance.belongsTo(LeaveType, {
  foreignKey: fk("leaveTypeId"),
  as: "leaveType",
});
LeaveType.hasMany(LeaveRequest, {
  foreignKey: fk("leaveTypeId"),
  as: "requests",
  onDelete: "RESTRICT",
});
LeaveRequest.belongsTo(LeaveType, {
  foreignKey: fk("leaveTypeId"),
  as: "leaveType",
});
LeaveRequest.belongsTo(User, {
  foreignKey: fk("reviewedBy", true),
  as: "reviewer",
  onDelete: "SET NULL",
});
LeaveAudit.belongsTo(User, {
  foreignKey: fk("actorId", true),
  as: "actor",
  onDelete: "SET NULL",
});
AttendanceAudit.belongsTo(User, {
  foreignKey: fk("changedBy", true),
  as: "editor",
  onDelete: "SET NULL",
});

/** Creation order matters for FK constraints. */
export const HRM_MODELS = [
  User,
  Department,
  Position,
  Employee,
  EmployeeDocument,
  WorkSchedule,
  Attendance,
  AttendanceAudit,
  LeaveType,
  LeaveBalance,
  LeaveRequest,
  LeaveAudit,
  Assignment,
];
export { sequelize, User };
