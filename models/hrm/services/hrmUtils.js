/* Pure date/time helpers for HRM. Dates are 'YYYY-MM-DD' strings, times 'HH:MM[:SS]'. */
export class HrmError extends Error {}

export const pad = (n) => String(n).padStart(2, "0");
export const todayStr = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const nowTime = (d = new Date()) =>
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
export const parseDate = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
export const addDays = (s, n) => {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return todayStr(d);
};
export const dow = (s) => parseDate(s).getDay();
export const toMin = (t) => {
  const [h, m] = String(t).split(":").map(Number);
  return h * 60 + m;
};
export const isDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return (
    dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
  );
};
export const isTime = (t) =>
  typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(t);
export const normTime = (t) => {
  if (t === null || t === undefined || t === "") return null;
  const s = String(t).trim();
  if (!isTime(s)) throw new HrmError("Invalid time. Use HH:MM or HH:MM:SS.");
  return s.length === 5 ? `${s}:00` : s;
};
export const normLabel = (s) => {
  const v = String(s ?? "")
    .trim()
    .replace(/\s+/g, " ");
  return v || null;
};

export const DEFAULT_WORKDAYS = "1,2,3,4,5,6"; // Mon-Sat (typical for construction)
export const DEFAULT_SHIFT = {
  shiftStart: "08:00:00",
  shiftEnd: "17:00:00",
  workDays: DEFAULT_WORKDAYS,
};
export const GRACE_MIN = 10; // minutes after shift start before a time-in counts as late

export function eachDate(from, to) {
  const out = [];
  for (let c = from, i = 0; c <= to && i < 400; c = addDays(c, 1), i++)
    out.push(c);
  return out;
}
export const isWorkday = (date, workDays = DEFAULT_WORKDAYS) =>
  workDays.split(",").includes(String(dow(date)));
export const countWorkdays = (from, to, workDays = DEFAULT_WORKDAYS) =>
  eachDate(from, to).filter((d) => isWorkday(d, workDays)).length;

export function deriveStatus(timeIn, shiftStart = DEFAULT_SHIFT.shiftStart) {
  if (!timeIn) return { status: "absent", minutesLate: 0 };
  const late = toMin(timeIn) - toMin(shiftStart);
  return late > GRACE_MIN
    ? { status: "late", minutesLate: late }
    : { status: "present", minutesLate: 0 };
}
// Overnight-aware: a time-out earlier than time-in is treated as next-day (e.g. 22:00 -> 06:00 = 8h).
export const hoursBetween = (a, b) => {
  if (!a || !b || !isTime(a) || !isTime(b)) return 0;
  const d = toMin(b) - toMin(a);
  return (d < 0 ? d + 1440 : d) / 60;
};
