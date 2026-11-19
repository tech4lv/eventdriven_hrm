/*
  Creates ONLY the HRM tables (hrm_*), in dependency order. Safe to re-run:
  it never drops or alters existing tables, unlike `npm run migrate` (which is
  now also non-destructive — plain sync(), no force).
*/
import "../../env.js";
import { sequelize, HRM_MODELS, Employee } from "./index.js";
import { databaseConfig, createRootSequelize } from "../db.js";
import { PasswordResetToken } from "../../models/userModel.js";
import { Session } from "../../models/sessionStore.js";

const DB_NAME = databaseConfig.database;
if (!/^[A-Za-z0-9_]+$/.test(DB_NAME)) {
  console.error(
    `❌ Invalid DB_NAME "${DB_NAME}" — use letters, numbers and underscores only.`,
  );
  process.exit(1);
}

try {
  const rootSequelize = createRootSequelize();
  await rootSequelize.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`;`);
  await rootSequelize.close();

  await sequelize.authenticate();
  for (const model of HRM_MODELS) {
    await model.sync();
    console.log(`✅ ${model.getTableName()}`);
  }
  // sync() never alters existing tables — pick up new Employee columns
  // (resignation fields) added after the table was first created.
  await Employee.sync({ alter: true });
  console.log("✅ hrm_employees (altered)");
  // Auth/session tables needed by the app (password reset + sessions).
  await PasswordResetToken.sync();
  await Session.sync();
  console.log("✅ password_reset_tokens, sessions");
  console.log("🎉 HRM tables are ready. Run `npm run hrm:seed` for demo data.");
} catch (err) {
  console.error("❌ HRM migration failed:", err);
  process.exitCode = 1;
} finally {
  await sequelize.close();
}
