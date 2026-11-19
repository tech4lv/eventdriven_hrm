import { Op, fn, col } from "sequelize";
import { Department, Position, Employee } from "../../models/hrm/index.js";
import { safe, plain, pick, bool, intOrNull } from "./_shared.js";

const counts = async (field) => {
  const rows = await Employee.findAll({
    attributes: [field, [fn("COUNT", col("id")), "n"]],
    where: { isActive: true },
    group: [field],
    raw: true,
  });
  return new Map(rows.map((r) => [r[field], Number(r.n)]));
};

// ---- Departments ----
export const deptIndex = safe(async (req, res) => {
  const q = (req.query.q || "").trim();
  const [depts, posCount, empCount, emps] = await Promise.all([
    Department.findAll({
      where: q ? { name: { [Op.like]: `%${q}%` } } : {},
      order: [["name", "ASC"]],
    }),
    Position.findAll({
      attributes: ["departmentId", [fn("COUNT", col("id")), "n"]],
      group: ["departmentId"],
      raw: true,
    }),
    counts("departmentId"),
    Employee.findAll({
      where: { isActive: true },
      order: [["lastName", "ASC"]],
    }),
  ]);
  const pc = new Map(posCount.map((r) => [r.departmentId, Number(r.n)]));
  const names = new Map(emps.map((e) => [e.id, e.fullName]));
  const rows = plain(depts).map((d) => ({
    ...d,
    positionCount: pc.get(d.id) || 0,
    employeeCount: empCount.get(d.id) || 0,
    headName: names.get(d.headEmployeeId) || null,
  }));
  res.render("hrm/departments/index", {
    title: "Departments",
    active: "departments",
    rows,
    q,
    employees: plain(emps),
  });
});

const deptFields = (b) => ({
  ...pick(b, ["name", "code", "description"], ["code", "description"]),
  headEmployeeId: intOrNull(b.headEmployeeId),
  isActive: b.isActive === undefined ? true : bool(b.isActive),
});
export const deptCreate = safe(async (req, res) => {
  await Department.create(deptFields(req.body));
  req.flash("success_msg", "Department created.");
  res.redirect("/hrm/departments");
});
export const deptUpdate = safe(async (req, res) => {
  const d = await Department.findByPk(req.params.id);
  if (!d) return res.redirect("/hrm/departments");
  await d.update(deptFields(req.body));
  req.flash("success_msg", "Department updated.");
  res.redirect("/hrm/departments");
});
export const deptDelete = safe(async (req, res) => {
  await Department.destroy({ where: { id: req.params.id } });
  req.flash("success_msg", "Department deleted.");
  res.redirect("/hrm/departments");
});

// ---- Positions ----
export const posIndex = safe(async (req, res) => {
  const { q = "", departmentId = "" } = req.query;
  const where = {};
  if (q.trim()) where.title = { [Op.like]: `%${q.trim()}%` };
  if (departmentId) where.departmentId = departmentId;
  const [positions, empCount, depts] = await Promise.all([
    Position.findAll({
      where,
      include: [{ model: Department, as: "department" }],
      order: [["title", "ASC"]],
    }),
    counts("positionId"),
    Department.findAll({ where: { isActive: true }, order: [["name", "ASC"]] }),
  ]);
  const rows = plain(positions).map((p) => ({
    ...p,
    employeeCount: empCount.get(p.id) || 0,
  }));
  res.render("hrm/positions/index", {
    title: "Job Positions",
    active: "positions",
    rows,
    q,
    departmentId,
    departments: plain(depts),
  });
});
const posFields = (b) => ({
  ...pick(b, ["title", "description"], ["description"]),
  departmentId: intOrNull(b.departmentId),
  isActive: b.isActive === undefined ? true : bool(b.isActive),
});
export const posCreate = safe(async (req, res) => {
  await Position.create(posFields(req.body));
  req.flash("success_msg", "Position created.");
  res.redirect("/hrm/positions");
});
export const posUpdate = safe(async (req, res) => {
  const p = await Position.findByPk(req.params.id);
  if (!p) return res.redirect("/hrm/positions");
  await p.update(posFields(req.body));
  req.flash("success_msg", "Position updated.");
  res.redirect("/hrm/positions");
});
export const posDelete = safe(async (req, res) => {
  await Position.destroy({ where: { id: req.params.id } });
  req.flash("success_msg", "Position deleted.");
  res.redirect("/hrm/positions");
});
