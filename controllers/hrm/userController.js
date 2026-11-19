import { User, Employee } from "../../models/hrm/index.js";
import { safe, plain } from "./_shared.js";

const ROLES = ["admin", "hr_staff", "employee"];

export const index = safe(async (req, res) => {
  const users = await User.findAll({
    attributes: { exclude: ["password"] },
    order: [["name", "ASC"]],
    include: [
      {
        model: Employee,
        as: "employees",
        attributes: ["id", "employeeNo", "firstName", "lastName", "isActive"],
        required: false,
      },
    ],
  });
  res.render("hrm/users/index", {
    title: "User Accounts",
    active: "users",
    roles: ROLES,
    users: plain(users),
  });
});

export const updateRole = safe(async (req, res) => {
  const role = String(req.body.role || "");
  if (!ROLES.includes(role)) {
    req.flash("error_msg", "Choose a valid role.");
    return res.redirect("/hrm/users");
  }
  if (Number(req.params.id) === req.hrm.user.id && role !== "admin") {
    req.flash("error_msg", "You cannot remove your own admin access.");
    return res.redirect("/hrm/users");
  }
  const user = await User.findByPk(req.params.id);
  if (!user) {
    req.flash("error_msg", "User not found.");
    return res.redirect("/hrm/users");
  }
  await user.update({ role });
  req.flash(
    "success_msg",
    `${user.name} is now ${role === "admin" ? "an admin" : `a ${role.replace("_", " ")}`}.`,
  );
  res.redirect("/hrm/users");
});
