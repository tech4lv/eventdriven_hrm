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

import { envBool, envInt, requireEnv } from "../env.js";
import { Sequelize } from "sequelize";

const isProd = process.env.NODE_ENV === "production";

const setting = (key, devDefault) => {
  const v = process.env[key];
  if (v !== undefined && String(v).trim() !== "") return String(v);
  if (isProd) throw new Error(`${key} environment variable is required.`);
  return devDefault;
};

const port = Number(setting("DB_PORT", "3306"));
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("DB_PORT must be a valid TCP port.");

export const databaseConfig = {
  database: setting("DB_NAME", "Rekta"),
  username: setting("DB_USER", "root"),
  password:
    process.env.DB_PASSWORD ?? (isProd ? requireEnv("DB_PASSWORD") : ""),
  host: setting("DB_HOST", "localhost"),
  port,
  dialect: "mysql",
  logging: false,
  ...(envBool("DB_SSL", false)
    ? {
        dialectOptions: {
          ssl: {
            rejectUnauthorized: envBool("DB_SSL_REJECT_UNAUTHORIZED", true),
          },
        },
      }
    : {}),
};

/** Server-level connection (no schema) used by migration scripts. */
export function createRootSequelize() {
  const { database, ...config } = databaseConfig;
  return new Sequelize(config);
}

export const sequelize = new Sequelize(databaseConfig);
