import crypto from "crypto";
import { User, Employee } from "../models/hrm/index.js";

const wantsJson = (req) => req.originalUrl.startsWith("/api/");

/** Loads the signed-in user (existing session auth), their employee record, and CSRF token. */
export async function hrmContext(req, res, next) {
  try {
    if (!req.session.userId)
      return wantsJson(req)
        ? res.status(401).json({ error: "Unauthorized" })
        : res.redirect("/login");
    const user = await User.findByPk(req.session.userId);
    if (!user) {
      req.session.destroy(() => {});
      return res.redirect("/login");
    }
    const employee = await Employee.findOne({ where: { userId: user.id } });
    const isHR = user.role === "admin" || user.role === "hr_staff";
    req.hrm = {
      user,
      employee,
      isAdmin: user.role === "admin",
      isHR,
      canAccess: isHR || !!employee?.isActive,
    };
    if (!req.session.csrf)
      req.session.csrf = crypto.randomBytes(24).toString("hex");
    res.locals.csrf = req.session.csrf;
    res.locals.isHR = isHR;
    res.locals.isAdmin = req.hrm.isAdmin;
    res.locals.me = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      employeeId: employee?.id || null,
    };
    next();
  } catch (e) {
    next(e);
  }
}

const deny = (req, res) =>
  wantsJson(req)
    ? res.status(403).json({ error: "Forbidden" })
    : res.status(403).render("hrm/403", { title: "Access denied", active: "" });

export const requireAccess = (req, res, next) => {
  if (req.hrm.canAccess) return next();
  // Signed in but not linked to an active employee record: friendly pending page, not a bare 403.
  return res
    .status(403)
    .render("hrm/pending", { title: "Account pending", active: "" });
};
export const requireHR = (req, res, next) =>
  req.hrm.isHR ? next() : deny(req, res);
export const requireAdmin = (req, res, next) =>
  req.hrm.isAdmin ? next() : deny(req, res);

/** Rejects state-changing requests without a valid session token (form field or ?_csrf=). */
export function csrfCheck(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const sent = String(req.body?._csrf || req.query?._csrf || "");
  const real = String(req.session.csrf || "");
  const ok =
    sent.length === real.length &&
    real &&
    crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(real));
  if (ok) return next();
  req.flash("error_msg", "Your session form token expired. Please try again.");
  return res.redirect(
    req.get("referer")
      ? new URL(req.get("referer"), "http://x").pathname
      : "/hrm",
  );
}
