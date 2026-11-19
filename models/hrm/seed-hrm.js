/*
  Demo data for the HRM module (idempotent: does nothing if departments already exist).
  Usage: npm run hrm:seed [-- --admin you@email.com]
    --admin <email>  promotes an existing registered user to the admin role
  If no admin exists and none is given, a demo admin is created (change the password!).
*/
import bcrypt from "bcrypt";
import {
  sequelize,
  HRM_MODELS,
  User,
  Department,
  Position,
  Employee,
  WorkSchedule,
  Attendance,
  LeaveType,
  LeaveRequest,
  Assignment,
} from "./index.js";
import {
  todayStr,
  addDays,
  isWorkday,
  deriveStatus,
} from "./services/hrmUtils.js";
import {
  ensureBalances,
  approveLeave,
  nextEmployeeNo,
} from "./services/hrmService.js";

for (const m of HRM_MODELS) await m.sync();
const argIdx = process.argv.indexOf("--admin");
if (argIdx > -1) {
  const u = await User.findOne({ where: { email: process.argv[argIdx + 1] } });
  if (u) {
    await u.update({ role: "admin" });
    console.log(`✅ ${u.email} is now admin`);
  } else console.log("⚠️  No user with that email. Register first.");
}
if (!(await User.findOne({ where: { role: "admin" } }))) {
  await User.create({
    name: "HR Admin",
    email: "admin@rektabuild.local",
    password: await bcrypt.hash("Admin@12345", 10),
    role: "admin",
  });
  console.log(
    "✅ Demo admin: admin@rektabuild.local / Admin@12345  (change this!)",
  );
}
if (!(await User.findOne({ where: { role: "hr_staff" } }))) {
  await User.create({
    name: "HR Staff",
    email: "hr@rektabuild.local",
    password: await bcrypt.hash("Hr@12345", 10),
    role: "hr_staff",
  });
  console.log("✅ Demo hr_staff: hr@rektabuild.local / Hr@12345");
}
if (await Department.count()) {
  console.log("ℹ️  HRM data already present; skipping demo data.");
  await sequelize.close();
  process.exit(0);
}

const dep = {};
for (const [name, code] of [
  ["Engineering", "ENG"],
  ["Construction Operations", "OPS"],
  ["Safety & Compliance", "HSE"],
  ["Administration", "ADM"],
  ["Procurement Liaison", "PRC"],
])
  dep[code] = await Department.create({ name, code });
const pos = {};
for (const [title, code] of [
  ["Project Engineer", "ENG"],
  ["Civil Engineer", "ENG"],
  ["Site Foreman", "OPS"],
  ["Mason", "OPS"],
  ["Carpenter", "OPS"],
  ["Heavy Equipment Operator", "OPS"],
  ["Safety Officer", "HSE"],
  ["HR Officer", "ADM"],
  ["Admin Assistant", "ADM"],
  ["Liaison Officer", "PRC"],
])
  pos[title] = await Position.create({ title, departmentId: dep[code].id });
for (const [name, days, paid] of [
  ["Vacation Leave", 10, true],
  ["Sick Leave", 7, true],
  ["Emergency Leave", 3, true],
  ["Unpaid Leave", 0, false],
])
  await LeaveType.create({ name, defaultDays: days, isPaid: paid });

const today = todayStr();
const people = [
  ["Maria", "Santos", "Mindoro Cruz", "female", "HR Officer", "ADM", "regular"],
  ["Juan", "Dela Cruz", null, "male", "Project Engineer", "ENG", "regular"],
  ["Ana", "Reyes", null, "female", "Civil Engineer", "ENG", "regular"],
  ["Pedro", "Ramos", null, "male", "Site Foreman", "OPS", "regular"],
  ["Jose", "Bautista", null, "male", "Mason", "OPS", "project-based"],
  ["Mario", "Garcia", null, "male", "Carpenter", "OPS", "project-based"],
  [
    "Luis",
    "Mendoza",
    null,
    "male",
    "Heavy Equipment Operator",
    "OPS",
    "contractual",
  ],
  ["Rosa", "Villanueva", null, "female", "Safety Officer", "HSE", "regular"],
  ["Carla", "Flores", null, "female", "Admin Assistant", "ADM", "probationary"],
  ["Noel", "Aquino", null, "male", "Mason", "OPS", "project-based"],
  ["Elena", "Torres", null, "female", "Liaison Officer", "PRC", "regular"],
  ["Ramon", "Castillo", null, "male", "Carpenter", "OPS", "probationary"],
].map(
  ([firstName, lastName, middleName, sex, position, d, employmentStatus]) => ({
    firstName,
    lastName,
    middleName,
    sex,
    position,
    d,
    employmentStatus,
  }),
);

const emps = [];
for (const [i, p] of people.entries()) {
  emps.push(
    await Employee.create({
      employeeNo: await nextEmployeeNo(),
      firstName: p.firstName,
      middleName: p.middleName,
      lastName: p.lastName,
      sex: p.sex,
      phone: `0917${String(1000000 + i * 1111).slice(0, 7)}`,
      email: `${p.firstName}.${p.lastName}@rektabuild.local`
        .toLowerCase()
        .replace(/ /g, ""),
      address: "Cabuyao, Laguna",
      hireDate: addDays(today, -400 + i * 20),
      employmentStatus: p.employmentStatus,
      departmentId: dep[p.d].id,
      positionId: pos[p.position].id,
    }),
  );
}
await Employee.update(
  { supervisorId: emps[3].id },
  { where: { id: [emps[4].id, emps[5].id, emps[9].id, emps[11].id] } },
);
// Link the demo hr_staff login to Maria's employee record so she gets self-service + HR access
const hrUser = await User.findOne({ where: { role: "hr_staff" } });
if (hrUser) await emps[0].update({ userId: hrUser.id });

// Attendance for the past 14 days (deterministic pseudo-random pattern)
for (const [i, e] of emps.entries())
  for (let n = 14; n >= 0; n--) {
    const date = addDays(today, -n);
    if (!isWorkday(date) || (n === 0 && i % 4 === 3)) continue;
    const roll = (i * 7 + n * 3) % 10;
    if (roll === 0 && n > 0) {
      await Attendance.create({ employeeId: e.id, date, status: "absent" });
      continue;
    }
    const timeIn =
      roll < 3
        ? `08:${String(12 + roll * 6).padStart(2, "0")}:00`
        : `07:${String(40 + roll * 2).padStart(2, "0")}:00`;
    await Attendance.create({
      employeeId: e.id,
      date,
      timeIn,
      timeOut: n === 0 ? null : "17:05:00",
      ...deriveStatus(timeIn),
    });
  }

await ensureBalances(Number(today.slice(0, 4)));
const vl = await LeaveType.findOne({ where: { name: "Vacation Leave" } }),
  sl = await LeaveType.findOne({ where: { name: "Sick Leave" } });
await LeaveRequest.create({
  employeeId: emps[2].id,
  leaveTypeId: vl.id,
  startDate: addDays(today, 7),
  endDate: addDays(today, 9),
  days: 3,
  reason: "Family trip",
});
await LeaveRequest.create({
  employeeId: emps[6].id,
  leaveTypeId: sl.id,
  startDate: addDays(today, 3),
  endDate: addDays(today, 3),
  days: 1,
  reason: "Medical check-up",
});
const done = await LeaveRequest.create({
  employeeId: emps[8].id,
  leaveTypeId: vl.id,
  startDate: addDays(today, 14),
  endDate: addDays(today, 15),
  days: 2,
  reason: "Personal matters",
});
const admin = await User.findOne({ where: { role: "admin" } });
await approveLeave(done.id, admin.id, "Approved");

const projects = [
  ["Riverside Condominium Tower", "Block A, Cabuyao"],
  ["Laguna Bypass Road Phase 2", "Km 12 Station"],
  ["Cabuyao Public Market Rehab", "Poblacion Site"],
];
for (const [i, e] of emps.slice(1).entries()) {
  const [projectName, siteName] = projects[i % 3];
  await Assignment.create({
    employeeId: e.id,
    projectName,
    siteName,
    roleOnProject: e.employmentStatus === "regular" ? "Supervision" : "Crew",
    startDate: addDays(today, -60),
  });
}
await WorkSchedule.create({
  employeeId: emps[7].id,
  workDays: "1,2,3,4,5",
  shiftStart: "07:00:00",
  shiftEnd: "16:00:00",
  effectiveFrom: addDays(today, -90),
});
console.log(
  `✅ Seeded ${emps.length} employees, attendance, leave, and assignments.`,
);
await sequelize.close();
