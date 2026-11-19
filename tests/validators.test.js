import test from "node:test";
import assert from "node:assert/strict";
import { EMAIL_RE, NAME_RE, PASSWORD_RE } from "../controllers/validators.js";

test("email validator accepts normal addresses only", () => {
  assert.equal(EMAIL_RE.test("hr@rektabuild.com"), true);
  assert.equal(EMAIL_RE.test("bad@"), false);
  assert.equal(EMAIL_RE.test("bad email@x.com"), false);
});

test("name validator accepts letters and common punctuation", () => {
  assert.equal(NAME_RE.test("Juan Dela Cruz"), true);
  assert.equal(NAME_RE.test("Mary-Jane O'Neil"), true);
  assert.equal(NAME_RE.test("123 Name"), false);
});

test("password validator enforces complexity", () => {
  assert.equal(PASSWORD_RE.test("Str0ng!Pass"), true);
  assert.equal(PASSWORD_RE.test("weakpass"), false);
  assert.equal(PASSWORD_RE.test("NoSpecial1"), false);
  assert.equal(PASSWORD_RE.test("short1!"), false);
});
