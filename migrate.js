import "./env.js";
import { sequelize, databaseConfig, createRootSequelize } from "./models/db.js";
import { User, PasswordResetToken } from "./models/userModel.js";
import { Session } from "./models/sessionStore.js";
import inquirer from "inquirer";

const DB_NAME = databaseConfig.database;
// DB_NAME is interpolated into CREATE DATABASE, so restrict it to safe chars.
if (!/^[A-Za-z0-9_]+$/.test(DB_NAME)) {
  console.error(
    `❌ Invalid DB_NAME "${DB_NAME}" — use letters, numbers and underscores only.`,
  );
  process.exit(1);
}

// Server-level connection (no schema) used only to create the database.
const rootSequelize = createRootSequelize();

const { createDb } = await inquirer.prompt([
  {
    type: "confirm",
    name: "createDb",
    message: `Database '${DB_NAME}' may not exist. Create it?`,
    default: true,
  },
]);

if (createDb) {
  await rootSequelize.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`;`);
  console.log(`✅ Database '${DB_NAME}' created (if it did not exist)`);
}
await rootSequelize.close();

try {
  await sequelize.authenticate();
  console.log(`✅ Connected to MySQL database '${DB_NAME}'!`);
  // Non-destructive: creates missing tables only, never drops data.
  // (Previously this used sync({ force: true }) which wiped all tables.)
  await sequelize.sync();
  console.log("✅ Tables created for all models (existing data preserved)!");
} catch (err) {
  console.error("❌ Migration failed:", err);
} finally {
  process.exit();
}
