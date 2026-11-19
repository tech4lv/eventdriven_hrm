import test from "node:test";
import assert from "node:assert/strict";
import {
  isDate,
  isTime,
  normTime,
  normLabel,
  hoursBetween,
  deriveStatus,
  isWorkday,
  countWorkdays,
  addDays,
  eachDate,
} from "../models/hrm/services/hrmUtils.js";

test("isDate accepts real dates and rejects impossible dates", () => {
  assert.equal(isDate("2024-02-29"), true);
  assert.equal(isDate("2023-02-29"), false);
  assert.equal(isDate("2024-02-30"), false);
  assert.equal(isDate("2024-13-01"), false);
  assert.equal(isDate("not-a-date"), false);
});

test("isTime/normTime validate and normalize times", () => {
  assert.equal(isTime("23:59"), true);
  assert.equal(isTime("24:00"), false);
  assert.equal(isTime("12:60"), false);
  assert.equal(normTime("08:00"), "08:00:00");
  assert.equal(normTime("08:00:30"), "08:00:30");
  assert.equal(normTime(""), null);
  assert.throws(() => normTime("8:00"), /Invalid time/);
});

test("hoursBetween handles overnight shifts", () => {
  assert.equal(hoursBetween("22:00", "06:00"), 8);
  assert.equal(hoursBetween("08:00", "17:00"), 9);
  assert.equal(hoursBetween("22:00:00", "06:00:00"), 8);
  assert.equal(hoursBetween("bad", "06:00"), 0);
});

test("deriveStatus applies grace minutes", () => {
  assert.deepEqual(deriveStatus("08:05", "08:00"), {
    status: "present",
    minutesLate: 0,
  });
  assert.deepEqual(deriveStatus("08:11", "08:00"), {
    status: "late",
    minutesLate: 11,
  });
  assert.deepEqual(deriveStatus(null, "08:00"), {
    status: "absent",
    minutesLate: 0,
  });
});

test("workday helpers respect custom schedules", () => {
  // 2024-01-07 is a Sunday.
  assert.equal(isWorkday("2024-01-06", "1,2,3,4,5,6"), true);
  assert.equal(isWorkday("2024-01-07", "1,2,3,4,5,6"), false);
  assert.equal(countWorkdays("2024-01-01", "2024-01-07", "1,2,3,4,5,6"), 6);
  assert.equal(countWorkdays("2024-01-01", "2024-01-07", "0"), 1);
});

test("date helpers and label normalization", () => {
  assert.equal(addDays("2024-01-31", 1), "2024-02-01");
  assert.deepEqual(eachDate("2024-01-01", "2024-01-03"), [
    "2024-01-01",
    "2024-01-02",
    "2024-01-03",
  ]);
  assert.equal(normLabel("  Project   Alpha  "), "Project Alpha");
  assert.equal(normLabel("   "), null);
});
