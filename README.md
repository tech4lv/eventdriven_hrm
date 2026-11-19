# Rekta-HRM

An HRM (Human Resource Management) module for the XianFire framework — built with Express, Sequelize (MySQL), and Handlebars (`.xian` templates). It provides a full server-rendered HR interface for managing employees, attendance, leave, scheduling, and project assignments.

## Features

### Core HR

- **Employee records** — full profiles (name, employee no., department, position, hire date, status), activate/deactivate, document uploads, resignation submission
- **Resignations** — employees submit resignation requests; admins approve or reject them
- **User accounts & roles** — admins can manage user roles (`admin`, `hr_staff`, employee)
- **Self-service portal** — employees view their own profile, change password, clock in/out, apply for leave, and upload documents

### Organization

- **Departments & positions** — CRUD with active/inactive flags and headcount tracking
- **Work schedules** — per-employee schedules with effective date ranges
- **Project assignments** — track which employees are assigned to which projects over time

### Time & Attendance

- **Time-in / time-out** clocking with attendance records
- **Calendar view** of attendance
- **HR-managed attendance** — manual save, bulk absence generation, record deletion
- **Attendance audit trail** (`hrm_attendance_audit`)

### Leave Management

- **Leave types** — configurable (paid/unpaid), managed by HR
- **Leave balances** — per-employee, per-year entitlements; auto-provisioned via `ensureBalances`
- **Leave requests** — apply, approve/reject (HR), cancel (employee)
- **Leave audit trail** (`hrm_leave_audit`)

### Reports & Dashboard

- HR dashboard with summary stats
- Reports module (`/hrm/reports`)

## Roles & Access Control

| Role | Access |
|---|---|
| `admin` | Everything, including resignations and user management |
| `hr_staff` | HR functions: employees, attendance management, leave approvals, org structure, assignments, reports |
| employee | Self-service only: own profile, attendance clocking, leave applications |

Middleware enforces this via `requireHR` / `requireAdmin` in `middleware/hrmAuth.js`. All state-changing routes are protected by CSRF checks.

## Data Model

All HRM tables are prefixed `hrm_` so they never collide with tables owned by other RektaBuild modules (Supply, Accounting, Inventory, Payroll). The only shared table referenced is `Users` (authentication).

### `hrm_departments`

| Column | Type | Notes |
|---|---|---|
| `name` | VARCHAR(100) | Unique, required |
| `code` | VARCHAR(20) | Unique, optional |
| `description` | TEXT | Optional |
| `headEmployeeId` | INT | Soft reference to department head (avoids circular FK) |
| `isActive` | BOOLEAN | Default `true` |

### `hrm_positions`

| Column | Type | Notes |
|---|---|---|
| `title` | VARCHAR(100) | Required |
| `description` | TEXT | Optional |
| `departmentId` | INT | FK → `hrm_departments` (RESTRICT) |
| `isActive` | BOOLEAN | Default `true` |

Unique index on `(title, departmentId)`.

### `hrm_employees`

| Column | Type | Notes |
|---|---|---|
| `employeeNo` | VARCHAR(20) | Unique employee number |
| `userId` | INT | Optional FK → `Users` (login account) |
| `firstName` / `middleName` / `lastName` / `suffix` | VARCHAR | Name parts (`fullName` is a virtual field) |
| `birthDate` | DATE | Optional |
| `sex` | ENUM | `male` / `female` |
| `civilStatus` | ENUM | `single` / `married` / `widowed` / `separated` |
| `phone` / `email` / `address` | | Contact info |
| `emergencyName` / `emergencyPhone` / `emergencyRelation` | | Emergency contact |
| `hireDate` | DATE | Required |
| `employmentStatus` | ENUM | `probationary`, `regular`, `contractual`, `project-based`, `resigned`, `terminated` |
| `supervisorId` | INT | Self-FK → supervisor employee (SET NULL) |
| `departmentId` / `positionId` | INT | FKs to org tables (SET NULL) |
| `isActive` | BOOLEAN | Default `true` |
| `resignationDate` / `resignationReason` | | Last working day + reason |
| `resignationStatus` | ENUM | `pending` / `approved` / `rejected` |
| `resignationReviewedBy` / `resignationReviewedAt` / `resignationReviewRemarks` | | Admin review fields |

### `hrm_employee_documents`

Uploaded files: `docType`, `title`, `originalName`, `filePath`, `mimeType`, `size`. FK → `hrm_employees`; `uploadedBy` → `Users` (SET NULL).

### `hrm_work_schedules`

Per-employee schedule with `workDays` (comma-separated, 0=Sun–6=Sat), `shiftStart`/`shiftEnd` (TIME), and `effectiveFrom`/`effectiveTo` date range. Indexed on `(employeeId, effectiveFrom)`.

### `hrm_attendance`

One row per employee per day (unique index on `(employeeId, date)`):

| Column | Notes |
|---|---|
| `date` | Work date |
| `timeIn` / `timeOut` | TIME, nullable |
| `status` | ENUM: `present`, `late`, `absent`, `on_leave`, `half_day` |
| `minutesLate` | Computed late minutes |
| `leaveRequestId` | Soft reference to the leave request that marked this day |
| `statusBeforeLeave` / `remarksBeforeLeave` | Preserved so leave cancellation can restore the original status |

### `hrm_attendance_audit`

Audit log for attendance changes: `attendanceId` (soft ref), `action`, `oldValues`/`newValues` (JSON), `changedBy` → `Users`, plus `employeeId` and `createdAt` indexes.

### Leave management

- **`hrm_leave_types`** — `name` (unique), `description`, `defaultDays` (DECIMAL(6,1)), `isPaid`, `isActive`
- **`hrm_leave_balances`** — per `(employeeId, leaveTypeId, year)` unique row: `entitled`, `used` (DECIMAL(6,1)); `remaining = entitled - used` is computed at read time
- **`hrm_leave_requests`** — `startDate`, `endDate`, `days`, `reason`, `status` (`pending`/`approved`/`rejected`/`cancelled`), `reviewedAt`, `reviewRemarks`, `reviewedBy` → `Users`
- **`hrm_leave_audit`** — same audit pattern as attendance: `leaveRequestId`, `action`, JSON `oldValues`/`newValues`, `actorId` → `Users`

### `hrm_project_assignments`

Employee ↔ project assignments with `projectId` (soft ref to the owning module's projects), `projectName`, `siteName`, `roleOnProject`, `startDate`, `endDate`, `status` (`active`/`completed`/`cancelled`), `notes`.

### Associations

- `Department` 1—N `Position`, `Employee`
- `Position` 1—N `Employee`
- `Employee` N—1 `Department`, `Position`, `User` (login), self-FK `supervisor`
- `Employee` 1—N `EmployeeDocument`, `WorkSchedule`, `Attendance`, `AttendanceAudit`, `LeaveBalance`, `LeaveRequest`, `LeaveAudit`, `Assignment`
- `LeaveType` 1—N `LeaveBalance`, `LeaveRequest`
- Delete behavior: `RESTRICT` on org/child relations, `SET NULL` on reviewer/actor/upload FKs

## Tech Stack

- **Runtime:** Node.js (ES modules)
- **Framework:** Express 4 on the XianFire framework (`bin/xian.js`)
- **Database:** MySQL via Sequelize 6 + mysql2
- **Views:** Handlebars (`hbs`) with `.xian` templates
- **Auth:** Session-based auth (express-session), bcrypt password hashing, API key auth
- **Other:** Multer (uploads), Nodemailer (password reset emails), connect-flash

## Getting Started

### Prerequisites

- Node.js 18+
- MySQL 8 (or compatible)

### Installation

```powershell
npm install
```

### Environment Setup

Copy `.env.example` to `.env` and fill in the values:

```powershell
copy .env.example .env
```

Key variables:

| Variable | Purpose |
|---|---|
| `PORT` | Server port (default `3000`; your dev setup uses `3001`) |
| `APP_BASE_URL` | Public base URL used in password-reset emails |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | MySQL connection |
| `SESSION_SECRET` | Required in production, min 32 chars |
| `SESSION_STORE` | `memory` (dev) or `mysql` (production default) |
| `SMTP_*` | Optional — emails password-reset links when configured |

Generate secrets with:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Database Setup

```powershell
npm run migrate      # run core migrations
npm run hrm:migrate  # run HRM migrations
npm run hrm:seed     # optional: seed HRM data
```

### Run

```powershell
npm run dev    # nodemon, auto-restart on changes
# or
npm start
```

The app runs at `http://localhost:<PORT>` (the server logs the actual URL on startup, e.g. `🔥 XianFire running at http://localhost:3001`).

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start with nodemon |
| `npm start` | Start with node |
| `npm test` | Run the test suite (`node --test`) |
| `npm run migrate` | Run core migrations |
| `npm run hrm:migrate` | Run HRM migrations |
| `npm run hrm:seed` | Seed HRM data |
| `npm run route:list` | List registered routes |
| `npm run route:cache` | Rebuild route cache |
| `npm run format` | Format JS + `.xian` templates with Prettier |
| `npm run create:*` | Scaffold models, controllers, middleware |

## Project Structure

```
├── bin/xian.js          # XianFire CLI entry
├── index.js             # App entry point
├── controllers/
│   ├── authController.js    # Login / register / password reset
│   ├── homeController.js
│   └── hrm/                 # HRM controllers (dashboard, employees,
│                            # attendance, leave, org, assignments,
│                            # reports, users, shared helpers)
├── middleware/           # hrmAuth (roles/CSRF), apiKeyAuth
├── models/
│   ├── hrm/index.js      # Sequelize model definitions
│   ├── hrm/migrate-hrm.js / seed-hrm.js
│   ├── hrm/services/     # hrmService (API logic), hrmUtils, projectsAdapter
│   ├── db.js             # Sequelize connection
│   ├── sessionStore.js   # memory / mysql session stores
│   └── userModel.js
├── routes/
│   ├── index.js          # Mounts /hrm and /api/hrm
│   └── hrm.js            # All HRM routes + API endpoints
├── views/                # .xian Handlebars templates (incl. views/hrm/*)
├── public/               # Static assets
└── tests/                # node:test test files
```

## Contributing

1. Create a branch for your changes
2. Run `npm test` and `npm run format` before committing
3. Commit with a clear message and open a pull request
