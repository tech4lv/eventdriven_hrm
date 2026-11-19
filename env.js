/*
  Loads .env from the project root into process.env (existing vars win).
  Uses Node's built-in process.loadEnvFile when available and falls back to
  a tiny parser on older runtimes, so no dotenv dependency is required.
  Import this module FIRST in every entry point that reads configuration.
*/
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, ".env");

if (fs.existsSync(envPath)) {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile(envPath);
  } else {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m || m[1].startsWith("#")) continue;
      let v = m[2].trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      )
        v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  }
}

export const env = (key, fallback) =>
  process.env[key] !== undefined ? process.env[key] : fallback;

export const envInt = (key, fallback) => {
  const raw = process.env[key];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
};

export const envBool = (key, fallback = false) => {
  const v = String(process.env[key] ?? "")
    .trim()
    .toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
};

/** Reads a required env var; empty strings count as missing. */
export function requireEnv(key) {
  const v = process.env[key];
  if (v === undefined || String(v).trim() === "")
    throw new Error(`${key} environment variable is required.`);
  return v;
}

export default env;
