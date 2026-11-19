import test from "node:test";
import assert from "node:assert/strict";

const enabled =
  process.env.HRM_TEST_DB === "1" && !!process.env.HRM_TEST_DB_NAME;

test("HRM database smoke test", { skip: !enabled }, async () => {
  process.env.DB_NAME = process.env.HRM_TEST_DB_NAME;
  const { sequelize } = await import("../models/hrm/index.js");
  await sequelize.authenticate();
  assert.equal(typeof sequelize.authenticate, "function");
});
