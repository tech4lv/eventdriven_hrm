import hbs from "hbs";
import {
  ValidationError,
  UniqueConstraintError,
  ForeignKeyConstraintError,
} from "sequelize";
import { HrmError } from "../../models/hrm/services/hrmUtils.js";
import { pad } from "../../models/hrm/services/hrmUtils.js";

/** Wraps async handlers: friendly flash messages for expected errors, next(err) otherwise. */
export const safe = (fn) => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (err) {
    let msg = null;
    if (err instanceof HrmError) msg = err.message;
    else if (err instanceof UniqueConstraintError)
      msg = `${err.errors?.[0]?.path || "Value"} already exists. Please use a different value.`;
    else if (err instanceof ValidationError)
      msg = err.errors.map((e) => e.message).join(", ");
    else if (err instanceof ForeignKeyConstraintError)
      msg =
        "That record is linked to other data. Set it to inactive instead of deleting it, or check the selected options.";
    if (!msg) return next(err);
    req.flash("error_msg", msg);
    res.redirect(back(req));
  }
};

export function back(req, fallback = "/hrm") {
  const ref = req.get("referer");
  if (!ref) return fallback;
  try {
    const u = new URL(ref);
    return u.host === req.get("host") ? u.pathname + u.search : fallback;
  } catch {
    return fallback;
  }
}

export const plain = (r) =>
  Array.isArray(r)
    ? r.map((x) => x.get({ plain: true }))
    : r
      ? r.get({ plain: true })
      : null;
export const bool = (v) =>
  v === true || v === "1" || v === "true" || v === "on";
export const intOrNull = (v) =>
  v === undefined || v === null || v === "" ? null : parseInt(v, 10);

/** Picks trimmed fields from a body; '' becomes null for fields listed in `nullable`. */
export function pick(body, keys, nullable = []) {
  const o = {};
  for (const k of keys) {
    let v = body[k];
    if (typeof v === "string") v = v.trim();
    if (v === "" && nullable.includes(k)) v = null;
    if (v !== undefined) o[k] = v;
  }
  return o;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const toYMD = (v) =>
  !v
    ? ""
    : v instanceof Date
      ? `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`
      : String(v).slice(0, 10);
const COLORS = {
  present: "emerald",
  late: "amber",
  absent: "red",
  on_leave: "sky",
  half_day: "violet",
  pending: "amber",
  approved: "emerald",
  rejected: "red",
  cancelled: "slate",
  active: "emerald",
  completed: "slate",
  regular: "emerald",
  probationary: "amber",
  contractual: "sky",
  "project-based": "violet",
  resigned: "slate",
  terminated: "red",
  not_in: "slate",
  day_off: "slate",
  upcoming: "slate",
  inactive: "slate",
  yes: "emerald",
  no: "slate",
};

let registered = false;
export function registerHelpers() {
  if (registered) return;
  registered = true;
  const H = (n, f) => hbs.registerHelper(n, f);
  H("eq", (a, b) => String(a) === String(b));
  H("sel", (a, b) => (String(a) === String(b) ? "selected" : ""));
  H("chk", (a, b) => (String(a) === String(b) ? "checked" : ""));
  H("json", (o) => JSON.stringify(o ?? {}));
  H("fmtDate", (v) => {
    const s = toYMD(v);
    if (!s) return "—";
    const [y, m, d] = s.split("-").map(Number);
    return `${MONTHS[m - 1]} ${d}, ${y}`;
  });
  H("fmtTime", (t) => {
    if (!t || typeof t !== "string") return "—";
    let [h, m] = t.split(":").map(Number);
    const ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${pad(m)} ${ap}`;
  });
  H("initials", (a, b) =>
    `${(a || "?")[0]}${(b || "")[0] || ""}`.toUpperCase(),
  );
  H("attRecord", (employeeId, date, rec) => ({
    employeeId,
    date,
    timeIn: rec?.timeIn || "",
    timeOut: rec?.timeOut || "",
    status: rec ? rec.status : "auto",
    remarks: rec?.remarks || "",
  }));
  H(
    "calCell",
    (s) =>
      ({
        present: "bg-emerald-100 text-emerald-800",
        late: "bg-amber-100 text-amber-800",
        absent: "bg-red-100 text-red-800",
        on_leave: "bg-sky-100 text-sky-800",
        half_day: "bg-violet-100 text-violet-800",
      })[s] || "bg-white",
  );
  H("statusLabel", (s) => String(s || "").replace(/_/g, " "));
  H("list", (...a) => a.slice(0, -1));
  H("schRecord", (employeeId, workDays, shiftStart, shiftEnd, today) => ({
    employeeId,
    workDays,
    shiftStart,
    shiftEnd,
    effectiveFrom: today,
  }));
  H("add", (a, b) => Number(a) + Number(b));
  H("num", (n) =>
    n === null || n === undefined
      ? "0"
      : Number(n).toLocaleString("en-US", { maximumFractionDigits: 1 }),
  );
  H("navc", (active, key) =>
    active === key
      ? "flex items-center gap-3 px-3 py-2 rounded-lg bg-blue-600 text-white font-semibold shadow-sm"
      : "flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-blue-900/40 hover:text-blue-100",
  );
  H("badge", (s) => {
    const c = COLORS[s] || "slate";
    const label = String(s ?? "—")
      .replace(/[_-]/g, " ")
      .replace(/^\w/, (x) => x.toUpperCase());
    return new hbs.handlebars.SafeString(
      `<span class="inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold bg-${c}-100 text-${c}-700">${hbs.handlebars.escapeExpression(label)}</span>`,
    );
  });
}
