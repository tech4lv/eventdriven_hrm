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

import { envBool } from "./env.js"; // load .env first so every config read below sees it
import express from "express";
import path from "path";
import crypto from "crypto";
import session from "express-session";
import flash from "connect-flash";
import router from "./routes/index.js";
import fs from "fs";
import hbs from "hbs";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const isProd = process.env.NODE_ENV === "production";
app.disable("x-powered-by");

// Only trust X-Forwarded-* headers when TRUST_PROXY is configured (e.g. "1",
// "loopback", or a hop count). req.ip feeds the login rate limiter.
const trustProxy = String(process.env.TRUST_PROXY || "")
  .trim()
  .toLowerCase();
if (trustProxy && !["false", "0", "off", "no"].includes(trustProxy)) {
  const hops = Number(trustProxy);
  app.set(
    "trust proxy",
    trustProxy === "true" ? true : Number.isInteger(hops) ? hops : trustProxy,
  );
}

// SESSION_SECRET must be a stable, long random string. In production a
// missing secret is a hard error; in development we warn and fall back to
// a random secret (sessions simply reset on restart).
if (isProd && !process.env.SESSION_SECRET) {
  throw new Error(
    "SESSION_SECRET environment variable is required when NODE_ENV=production.",
  );
}
if (!process.env.SESSION_SECRET) {
  console.warn(
    "⚠️  SESSION_SECRET is not set — using a random secret (sessions reset on restart). Set it in .env.",
  );
}
const sessionSecret =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (sessionSecret.length < 32) {
  throw new Error(
    "SESSION_SECRET must be at least 32 characters. Generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"",
  );
}

// Session storage: "mysql" persists sessions in the `sessions` table
// (required for production / multi-process); "memory" is dev-only default.
const storePref = (process.env.SESSION_STORE || (isProd ? "mysql" : "memory"))
  .toLowerCase()
  .trim();
if (isProd && storePref === "memory") {
  throw new Error(
    "SESSION_STORE=memory is not allowed when NODE_ENV=production. Use SESSION_STORE=mysql.",
  );
}
let sessionStore;
if (storePref === "mysql") {
  try {
    const { createSessionStore } = await import("./models/sessionStore.js");
    sessionStore = await createSessionStore();
    console.log("🗄️  Session store: MySQL (sessions table)");
  } catch (e) {
    if (isProd) throw e;
    console.error(
      "❌ Failed to initialise MySQL session store:",
      e.message,
      "\n   Falling back to in-memory sessions (dev only).",
    );
  }
} else if (storePref !== "memory") {
  const msg = `Unknown SESSION_STORE "${storePref}" — using in-memory sessions.`;
  if (isProd) throw new Error(msg);
  console.warn(`⚠️  ${msg}`);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(process.cwd(), "public")));

app.use(
  session({
    store: sessionStore, // undefined → express-session MemoryStore (dev only)
    name: "rektabuild.sid",
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: envBool("COOKIE_SECURE", isProd),
      maxAge: 8 * 60 * 60 * 1000,
    }, // 8h idle timeout
  }),
);
app.use(flash());

// Session CSRF token for the public auth forms (login/register/forgot/reset).
// /hrm routes reuse the same token via middleware/hrmAuth.js.
app.use((req, res, next) => {
  if (!req.session.csrf)
    req.session.csrf = crypto.randomBytes(24).toString("hex");
  res.locals.csrfToken = req.session.csrf;
  next();
});

app.engine("xian", async (filePath, options, callback) => {
  try {
    const originalPartialsDir = hbs.partialsDir;
    hbs.partialsDir = path.join(__dirname, "views");

    const result = await new Promise((resolve, reject) => {
      hbs.__express(filePath, options, (err, html) => {
        if (err) return reject(err);
        resolve(html);
      });
    });

    hbs.partialsDir = originalPartialsDir;
    callback(null, result);
  } catch (err) {
    callback(err);
  }
});
app.use((req, res, next) => {
  res.locals.success_msg = req.flash("success_msg");
  res.locals.error_msg = req.flash("error_msg");
  next();
});

// Never cache dynamic pages: after logout, the browser back button must
// re-request from the server (which then redirects to /login).
app.use((req, res, next) => {
  res.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "SAMEORIGIN");
  res.set("Referrer-Policy", "same-origin");
  next();
});

app.set("views", path.join(__dirname, "views"));
app.set("view engine", "xian");
const partialsDir = path.join(__dirname, "views/partials");
fs.readdir(partialsDir, (err, files) => {
  if (err) {
    console.error("❌ Could not read partials directory:", err);
    return;
  }

  files
    .filter((file) => file.endsWith(".xian"))
    .forEach((file) => {
      const partialName = file.replace(".xian", "");
      const fullPath = path.join(partialsDir, file);

      fs.readFile(fullPath, "utf8", (err, content) => {
        if (err) {
          console.error(`❌ Failed to read partial: ${file}`, err);
          return;
        }
        hbs.registerPartial(partialName, content);
      });
    });
});

app.use("/", router);

export default app;

// Start the HTTP server; resolves once the server is listening.
// Exported so the Electron main process can control startup itself.
export const startServer = (port = PORT) => {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`🔥 XianFire running at http://localhost:${port}`);
      resolve(server);
    });
    server.on("error", reject);
  });
};

// Auto-start only when executed directly (node index.js).
// When imported by electron/main.js, Electron manages the server lifecycle.
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun && !process.env.XIAN_ELECTRON) {
  startServer();
}
