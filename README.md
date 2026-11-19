# RektaBuild HRMS — Human Resource Management System

A web-based HR system for RektaBuild. It keeps employee records, departments and positions, daily attendance, leave requests, work schedules and project assignments in one place, with separate access for administrators, HR staff and employees.

Built on the XianFire Framework (Node.js and Express) with MySQL, Sequelize and server-rendered `.xian` (Handlebars) views styled with Tailwind CSS.

## Features

| Module | What it does |
|---|---|
| Dashboard | Company overview for admin and staff: headcount, attendance, pending leave requests and other HR summaries. Employees get a personal dashboard instead. |
| Employees | Add, view, edit, deactivate and reactivate employee records with generated employee numbers. Upload and manage employee documents. Employees can submit resignation requests; admins approve or reject them. |
| Self-service | Employees view their own profile, change their password, clock in and out, file leave and track balances — no HR access needed. |
| Departments & Positions | Create departments, set a department head, manage positions. A department or position with employees cannot be deleted. |
| Attendance | Employees check in and out themselves; time-in after the shift start plus a grace period is marked Late with the minutes counted. HR records or corrects attendance for any date and can bulk-generate absences. |
| Leave Management | Employees file leave; admin or staff approve or reject it. Leave balances per type are tracked per calendar year and enforced on filing and on approval. Rest days are not counted. |
| Schedules & Assignments | Per-employee work schedules with effective date ranges, and project assignments tracking who works on which project, site and role. |
| Reports | Printable employee, department, attendance, leave and assignment reports for a date range. |
| User Accounts | Admin changes user roles and links accounts to employee records. Public registration always creates an unlinked employee account. |

Lists are paginated, deletes and final actions ask for confirmation, and the interface is styled with Tailwind CSS.

## Roles

| Role | Access |
|---|---|
| Admin | Everything, including user accounts, resignations and deleting records |
| Staff (HR) | Employees, departments and positions, attendance, leave approval, schedules, assignments, reports |
| Employee | Own profile, own attendance (check in / out), filing leave, own documents and resignation requests |

Access is checked on the server for every route, so typing a URL directly shows Access Denied for a page the role may not open. Public registration always creates an `employee` account that is not linked to any employee record; only an administrator assigns roles.

## Business rules

| Rule | Value |
|---|---|
| Default shift | 08:00–17:00, configurable per employee schedule |
| Late after | Shift start + 10-minute grace (`GRACE_MIN` in `hrmUtils.js`) |
| Default workdays | Monday–Saturday (`1,2,3,4,5,6`), configurable per schedule |
| Leave balances | Per employee, per leave type, per calendar year (`entitled` / `used`, `remaining` computed) |
| Overlapping leave | Refused while another pending or approved leave covers the same dates |
| Insufficient balance | Filing and approval are both refused when days exceed the remaining balance |
| Attendance | One record per employee per day (unique index on `employeeId, date`) |
| Resignation | Employee submits → admin approves or rejects; approved resignations update employment status |
| Leave and attendance | Approved leave marks attendance days as `on_leave`, preserving the original status so cancellation can restore it |

## Requirements

- Node.js 18 or newer
- MySQL 8 (for example Laragon), with user `root` and no password by default

## Getting started

```powershell
git clone https://github.com/tech4lv/eventdriven_hrm.git
cd Rekta-HRM
npm install
```

Start MySQL (in Laragon: **Start All**).

Copy `.env.example` to `.env` and change the values if your database is different:

```powershell
copy .env.example .env
```

Create the database and tables:

```powershell
npm run migrate
```

It asks whether to create the database, then runs `sequelize.sync()` — non-destructive, it only creates missing tables and never deletes data.

Seed demo data (departments, positions, leave types, sample employees) — this also creates a demo admin if no admin exists yet:

```powershell
npm run hrm:seed
# or promote your own registered account:
npm run hrm:seed -- --admin you@email.com
```

Start the app:

```powershell
npm run dev
```

Open `http://localhost:3000` (or the port shown at startup) and sign in.

## Configuration

Settings are read from `.env` in the project folder. Values already set in the shell win.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Web server port |
| `APP_BASE_URL` | `http://localhost:5000` | Public base URL used in password-reset emails |
| `TRUST_PROXY` | empty | Set only when behind a trusted reverse proxy |
| `COOKIE_SECURE` | empty | Override secure cookies (defaults to true in production) |
| `DB_HOST` / `DB_PORT` | `localhost` / `3306` | MySQL host and port |
| `DB_NAME` | `Rekta` | Database name |
| `DB_USER` / `DB_PASSWORD` | `root` / empty | MySQL credentials |
| `DB_SSL` / `DB_SSL_REJECT_UNAUTHORIZED` | `false` / `true` | MySQL SSL options |
| `SESSION_SECRET` | empty | Signs the login cookie. Required in production (min 32 chars) |
| `SESSION_STORE` | `memory` | `memory` for dev, `mysql` persists sessions in the `sessions` table |
| `SMTP_*` | empty | Optional — emails password-reset links when configured |
| `PASSWORD_RESET_EXPOSE_LINK` | auto | Show the reset link in the browser when SMTP is not configured (dev only) |

Never commit `.env`; it is listed in `.gitignore`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Starts the app with nodemon; restarts on file changes |
| `npm start` | Starts the app without auto-restart |
| `npm test` | Runs the `node --test` suite (utils, validators, CSV safety, migration safety, HRM db tests) |
| `npm run migrate` | Creates the database and missing tables |
| `npm run hrm:migrate` | Runs the HRM migrations |
| `npm run hrm:seed` | Seeds demo HRM data and ensures an admin exists |
| `npm run route:list` | Lists every route |
| `npm run route:cache` | Rebuilds the route cache |
| `npm run format` | Formats JS and `.xian` templates with Prettier |
| `npm run create:model` / `create:controller` / `create:add-middleware` / `create:upload-middleware` | XianFire generators for new files |

## Project structure

```
env.js            loads .env before anything else
controllers/     request handling (authController, homeController, hrm/*)
middleware/      login and role checks (hrmAuth, apiKeyAuth)
models/          Sequelize models and relations (User, session store, db)
models/hrm/      HRM models, migrations, seeders and services
routes/          every URL and the role allowed to open it
views/           .xian pages; partials/ holds the shared layout pieces
public/          static assets (tailwind.css)
index.js         Express app: sessions, flash messages, view engine, routes
migrate.js       safe database setup
tests/           node:test test files
```

The app follows MVC: a request goes to a route, the route's role check runs, the controller reads or writes through the models, and a `.xian` view renders the page.

