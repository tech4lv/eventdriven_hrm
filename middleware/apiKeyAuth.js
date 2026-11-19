import crypto from "crypto";
import { env } from "../env.js";
import { hrmContext, requireHR } from "./hrmAuth.js";

const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

const providedKey = (req) => {
  const header = req.get("X-API-Key");
  if (header) return header;
  const auth = req.get("Authorization") || "";
  return auth.replace(/^Bearer\s+/i, "");
};

/*
  Machine-to-machine access for /api/hrm: accepts a shared HRM_API_KEY sent as
  `X-API-Key: <key>` or `Authorization: Bearer <key>`. Without a valid key it
  falls back to the normal browser session auth (hrmContext + requireHR), so
  HR staff can still test the endpoints from Postman while logged in.
*/
export function apiKeyOrSession(req, res, next) {
  const expected = env("HRM_API_KEY", "");
  const sent = providedKey(req);
  if (expected && sent && safeEqual(sent, expected)) {
    req.apiKeyAuth = true;
    return next();
  }
  hrmContext(req, res, (err) => {
    if (err) return next(err);
    requireHR(req, res, next);
  });
}
