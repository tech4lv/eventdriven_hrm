/*
    MIT License
    
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
    */

import crypto from "crypto";
import bcrypt from "bcrypt";
import nodemailer from "nodemailer";
import { envBool, envInt } from "../env.js";
import { User, PasswordResetToken, sequelize } from "../models/userModel.js";

// ===================== validation rules =====================
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_RE = /^[\p{L}][\p{L}\s.'’-]{1,99}$/u;
// dapat may 8+ chars, uppercase, lowercase, number, at special char
const PASSWORD_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
const PASSWORD_RULES =
  "Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a special character.";

// ===================== helpers =====================

// para hindi ma-crash ang server kapag may error sa controller
const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (e) {
    next(e);
  }
};

// kapag may error, flash lang ng message tapos bumalik sa form
const fail = (req, res, msg, url) => {
  req.flash("error_msg", msg);
  res.redirect(url);
};

// check kung tama ang csrf token na galing sa hidden field ng form
function csrfOk(req) {
  const sent = Buffer.from(String(req.body._csrf || ""));
  const real = Buffer.from(String(req.session.csrf || ""));
  return (
    sent.length > 0 &&
    sent.length === real.length &&
    crypto.timingSafeEqual(sent, real)
  );
}

// hanapin ang user kahit anong case ng email (hal. ADMIN@X.com = admin@x.com)
const findByEmail = (email) =>
  User.findOne({
    where: sequelize.where(
      sequelize.fn("LOWER", sequelize.col("email")),
      email,
    ),
  });

// ===================== rate limiter factory =====================
// per-IP in-memory limiter: max N attempts, tapos cooldown ng windowMs.
// ok lang para sa single-process; kung mag-mi-multiple servers, ilipat sa Redis/DB.
const createLimiter = (maxAttempts, windowMs) => {
  const attempts = new Map(); // ip -> { count, resetAt }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, a] of attempts) {
      if (a.resetAt <= now) attempts.delete(ip);
    }
  }, windowMs);
  sweep.unref?.();

  return {
    tooMany(ip) {
      const a = attempts.get(ip);
      return !!(a && a.resetAt > Date.now() && a.count >= maxAttempts);
    },
    fail(ip) {
      const now = Date.now();
      const a = attempts.get(ip);
      if (!a || a.resetAt <= now) {
        attempts.set(ip, { count: 1, resetAt: now + windowMs });
      } else {
        a.count += 1;
      }
    },
    clear(ip) {
      attempts.delete(ip);
    },
  };
};

// login: max 5 maling attempts per IP, tapos 15 mins cooldown
const ATTEMPT_WINDOW = 15 * 60 * 1000; // 15 minutes in milliseconds
const loginLimiter = createLimiter(5, ATTEMPT_WINDOW);
// forgot/reset password: mas maluwag pero may limit din para di ma-spam
const resetLimiter = createLimiter(10, ATTEMPT_WINDOW);

const tooManyAttempts = (ip) => loginLimiter.tooMany(ip);
const addFailedAttempt = (ip) => loginLimiter.fail(ip);
const clearAttempts = (ip) => loginLimiter.clear(ip);

// ===================== forgot password tokens =====================
// ang token ay sine-store sa database bilang SHA-256 hash lang,
// may expiry at single-use (usedAt). Hindi na nawawala sa restart.
const RESET_MINUTES = 30;
const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

async function makeResetToken(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  await PasswordResetToken.destroy({ where: { userId, usedAt: null } });
  await PasswordResetToken.create({
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + RESET_MINUTES * 60 * 1000),
  });
  return token;
}

// babalikan ang user id kapag valid pa ang token
async function getResetUserId(token) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return null;
  const rec = await PasswordResetToken.findOne({
    where: { tokenHash: hashToken(token), usedAt: null },
  });
  if (!rec) return null;
  if (rec.expiresAt <= new Date()) {
    await rec.destroy();
    return null;
  }
  return rec.userId;
}

// Atomically marks the token used so concurrent resets cannot reuse it.
async function consumeResetToken(token) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return null;
  const rec = await PasswordResetToken.findOne({
    where: { tokenHash: hashToken(token), usedAt: null },
  });
  if (!rec || rec.expiresAt <= new Date()) return null;
  const [affected] = await PasswordResetToken.update(
    { usedAt: new Date() },
    { where: { id: rec.id, usedAt: null } },
  );
  return affected ? rec.userId : null;
}

// ===================== password reset delivery =====================
// SMTP is optional. When it is not configured, the reset link may only be
// shown in non-production (demo mode) or when explicitly enabled.
let mailTransporter;
const smtpConfigured = () => Boolean(process.env.SMTP_HOST);
const resetLink = (token) => {
  const base = String(process.env.APP_BASE_URL || "")
    .trim()
    .replace(/\/+$/, "");
  const path = `/reset-password?token=${encodeURIComponent(token)}`;
  return base ? `${base}${path}` : path;
};
const exposeResetLink = () =>
  envBool("PASSWORD_RESET_EXPOSE_LINK", process.env.NODE_ENV !== "production");

function getMailTransporter() {
  if (!smtpConfigured()) return null;
  if (mailTransporter) return mailTransporter;
  const port = envInt("SMTP_PORT", 587);
  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: envBool("SMTP_SECURE", port === 465),
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" }
      : undefined,
    tls: { rejectUnauthorized: envBool("SMTP_TLS_REJECT_UNAUTHORIZED", true) },
  });
  return mailTransporter;
}

async function sendResetEmail(user, link) {
  const transporter = getMailTransporter();
  if (!transporter) return false;
  const absoluteLink = link.startsWith("http")
    ? link
    : `${process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 5000}`}${link}`;
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: user.email,
    subject: "Reset your RektaBuild password",
    text: [
      `Hi ${user.name},`,
      "",
      "We received a request to reset your RektaBuild password.",
      `Open this link to choose a new password: ${absoluteLink}`,
      "",
      "This link expires in 30 minutes and can only be used once.",
      "If you did not request this, you can ignore this email.",
    ].join("\n"),
  });
  return true;
}

// Returns "email" | "link" | "none". "none" means no safe delivery channel.
async function deliverResetLink(user, token) {
  if (smtpConfigured()) {
    try {
      await sendResetEmail(user, resetLink(token));
      return "email";
    } catch (e) {
      // Keep the response generic; the token remains valid for a retry.
      console.error("Password reset email failed:", e.message);
      return "email";
    }
  }
  return exposeResetLink() ? "link" : "none";
}

// ===================== pages =====================

export const loginPage = (req, res) =>
  res.render("login", { title: "Login | RektaBuild" });
export const registerPage = (req, res) =>
  res.render("register", { title: "Register | RektaBuild" });
export const forgotPasswordPage = (req, res) =>
  res.render("forgotpassword", { title: "Forgot Password | RektaBuild" });

// ===================== login =====================

export const loginUser = wrap(async (req, res) => {
  if (!csrfOk(req))
    return fail(
      req,
      res,
      "Your session form token expired. Please try again.",
      "/login",
    );
  if (tooManyAttempts(req.ip)) {
    return fail(
      req,
      res,
      "Too many failed attempts. Please try again in 15 minutes.",
      "/login",
    );
  }

  const email = String(req.body.email || "")
    .trim()
    .toLowerCase();
  const password = String(req.body.password || "");

  if (!email || !password)
    return fail(req, res, "Email and password are required.", "/login");

  const user = await findByEmail(email);
  const match = user ? await bcrypt.compare(password, user.password) : false;

  // iisang error message para di ma-guess kung existing ang email
  if (!user || !match) {
    addFailedAttempt(req.ip);
    return fail(req, res, "Invalid email or password.", "/login");
  }

  clearAttempts(req.ip);

  // bagong session para secure ang login (hindi na magagamit ang lumang session id)
  await new Promise((resolve, reject) =>
    req.session.regenerate((e) => (e ? reject(e) : resolve())),
  );
  req.session.userId = user.id;
  res.redirect("/hrm");
});

// ===================== register =====================

export const registerUser = wrap(async (req, res) => {
  if (!csrfOk(req))
    return fail(
      req,
      res,
      "Your session form token expired. Please try again.",
      "/register",
    );

  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "")
    .trim()
    .toLowerCase();
  const password = String(req.body.password || "");
  const confirmPassword = String(req.body.confirmPassword || "");

  const errors = [];
  if (!NAME_RE.test(name))
    errors.push(
      "Enter a valid name (letters, spaces, and basic punctuation only).",
    );
  if (email.length > 120 || !EMAIL_RE.test(email))
    errors.push("Enter a valid email address.");
  if (!PASSWORD_RE.test(password)) errors.push(PASSWORD_RULES);
  else if (password !== confirmPassword) errors.push("Passwords do not match.");
  if (errors.length) return fail(req, res, errors.join(" "), "/register");

  // bawal ang duplicate email
  if (await findByEmail(email)) {
    return fail(
      req,
      res,
      "An account with this email already exists. Try logging in instead.",
      "/register",
    );
  }

  const hashed = await bcrypt.hash(password, 10);
  const user = await User.create({
    name,
    email,
    password: hashed,
    role: "employee",
  });

  await new Promise((resolve, reject) =>
    req.session.regenerate((e) => (e ? reject(e) : resolve())),
  );
  req.session.userId = user.id;
  res.redirect("/hrm");
});

// ===================== forgot / reset password =====================

export const forgotPassword = wrap(async (req, res) => {
  if (!csrfOk(req))
    return fail(
      req,
      res,
      "Your session form token expired. Please try again.",
      "/forgot-password",
    );

  if (resetLimiter.tooMany(req.ip)) {
    return fail(
      req,
      res,
      "Too many reset attempts. Please try again in 15 minutes.",
      "/forgot-password",
    );
  }
  resetLimiter.fail(req.ip);

  const email = String(req.body.email || "")
    .trim()
    .toLowerCase();
  const user =
    EMAIL_RE.test(email) && email.length <= 120
      ? await findByEmail(email)
      : null;
  // parehong tugon kahit may account o wala para di ma-guess ang registered emails
  if (!user)
    return fail(
      req,
      res,
      "If an account exists for that email, a password reset link will be sent.",
      "/forgot-password",
    );

  if (!smtpConfigured() && !exposeResetLink()) {
    console.error(
      `Password reset requested for ${user.email} but SMTP is not configured and reset-link exposure is disabled.`,
    );
    return fail(
      req,
      res,
      "If an account exists for that email, a password reset link will be sent.",
      "/forgot-password",
    );
  }
  const token = await makeResetToken(user.id);
  const delivery = await deliverResetLink(user, token);
  res.render("resetpassword", {
    title: "Reset Password | RektaBuild",
    mode: delivery === "link" ? "issued" : "sent",
    link: delivery === "link" ? resetLink(token) : null,
    email: delivery === "link" ? user.email : null,
  });
});

export const resetPasswordPage = wrap(async (req, res) => {
  const userId = await getResetUserId(req.query.token);
  if (!userId) {
    return res.status(400).render("resetpassword", {
      title: "Reset Password | RektaBuild",
      mode: "invalid",
    });
  }
  res.render("resetpassword", {
    title: "Reset Password | RektaBuild",
    mode: "form",
    token: req.query.token,
  });
});

export const resetPassword = wrap(async (req, res) => {
  if (!csrfOk(req))
    return fail(
      req,
      res,
      "Your session form token expired. Please try again.",
      "/forgot-password",
    );

  if (resetLimiter.tooMany(req.ip)) {
    return fail(
      req,
      res,
      "Too many reset attempts. Please try again in 15 minutes.",
      "/forgot-password",
    );
  }
  resetLimiter.fail(req.ip);

  const token = String(req.body.token || "");
  const userId = await getResetUserId(token);
  if (!userId) {
    return res.status(400).render("resetpassword", {
      title: "Reset Password | RektaBuild",
      mode: "invalid",
    });
  }

  const password = String(req.body.password || "");
  const errors = [];
  if (!PASSWORD_RE.test(password)) errors.push(PASSWORD_RULES);
  else if (password !== String(req.body.confirmPassword || ""))
    errors.push("Passwords do not match.");
  if (errors.length) {
    req.flash("error_msg", errors.join(" "));
    return res.redirect(`/reset-password?token=${encodeURIComponent(token)}`);
  }

  const user = await User.findByPk(userId);
  if (!user) {
    return res.status(400).render("resetpassword", {
      title: "Reset Password | RektaBuild",
      mode: "invalid",
    });
  }

  // isang beses lang magagamit ang token — mark as used
  const consumedUserId = await consumeResetToken(token);
  if (consumedUserId !== user.id) {
    return res.status(400).render("resetpassword", {
      title: "Reset Password | RektaBuild",
      mode: "invalid",
    });
  }
  await user.update({ password: await bcrypt.hash(password, 10) });
  req.flash(
    "success_msg",
    "Password updated. You can now log in with your new password.",
  );
  res.redirect("/login");
});

// ===================== logout =====================

export const logoutUser = wrap(async (req, res) => {
  if (!csrfOk(req))
    return fail(
      req,
      res,
      "Your session form token expired. Please try again.",
      "/",
    );
  await new Promise((resolve, reject) =>
    req.session.destroy((e) => (e ? reject(e) : resolve())),
  );
  res.redirect("/login");
});
