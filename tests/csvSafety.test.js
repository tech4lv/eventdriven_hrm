import test from "node:test";
import assert from "node:assert/strict";
import { csvCell } from "../controllers/hrm/reportController.js";

test("csvCell neutralizes spreadsheet formula injection", () => {
  assert.equal(csvCell("=1+1"), "'=1+1");
  assert.equal(csvCell("  +cmd"), "'  +cmd");
  assert.equal(csvCell("-2+3"), "'-2+3");
  assert.equal(csvCell("@SUM(A1:A2)"), "'@SUM(A1:A2)");
});

test("csvCell quotes commas, quotes, and newlines", () => {
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("line1\nline2"), '"line1\nline2"');
  assert.equal(csvCell(null), "");
});
