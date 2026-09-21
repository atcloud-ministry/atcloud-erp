# @Cloud Sign-up System

Full-stack event and workshop sign-up platform (Node/Express + React/TypeScript) with real-time updates and a comprehensive automated test suite.

## Quick start

- Install dependencies: use the root script to install backend and frontend
- Dev servers: backend on 5001, frontend on 5173 (proxy to backend)
- Health and monitor routes: see `docs/MONITOR_ROUTES.md`

## Development Setup Scripts

For local development, you can quickly set up test users and sample data:

### Setup Test Users

Creates basic test users for development:

```bash
cd backend
npm run setup-users
```

**Created users:**

- **Super Admin:** `test-admin@example.com` / `AdminPassword123!`
- **Leader:** `test-leader@example.com` / `LeaderPassword123!`
- **Participant:** `test-user@example.com` / `UserPassword123!`

### Regenerate All Users

⚠️ **WARNING:** Deletes all existing users and creates a fresh set:

```bash
cd backend
npm run regenerate-users
```

**Created users:**

- **Super Admin:** `test-superadmin@example.com` / `SuperAdmin123!`
- **Administrator:** `test-admin-john@example.com` / `AdminPass123!`
- **Leader:** `test-leader-sarah@example.com` / `LeaderPass123!`
- **Participant 1:** `test-participant-mike@example.com` / `ParticipantPass123!`
- **Participant 2:** `test-participant-emily@example.com` / `ParticipantPass123!`

### Create Sample Data

Creates users, events, and registrations for a complete dev environment:

```bash
cd backend
npm run create-sample-data
```

**Note:** All test accounts use `@example.com` domain to avoid confusion with real accounts.

## Pre-Deployment Checklist

**Before deploying to production**, run:

```bash
npm run pre-deploy
```

This will:

1. Clean install dependencies (catches missing packages)
2. Run lint + type-check
3. Build production bundles
4. Run all tests

For more details, see `docs/PRE_DEPLOYMENT_CHECKLIST.md`

**Quick checks**:

- `npm run verify` - Lint + type-check only
- `npm run check-deps` - List all dependencies
- `npm run clean-install` - Fresh install both workspaces

## Testing

- Run the full test suite from the repo root: `npm test`
- Backend and frontend tests will run sequentially
- Test database: MongoDB on localhost using `atcloud-signup-test` (ensure MongoDB is running locally)

## Terminology (important)

We distinguish between:

- System Authorization Level "Leader" (do not rename in code or docs where it denotes permissions)
- User-facing @Cloud status label: “@Cloud Co-worker”

See `docs/TERMINOLOGY.md` for guidance and examples.

## Useful docs

- [Alumni directory, help, messaging, and PWA implementation roadmap](docs/ALUMNI_DIRECTORY_REFERRAL_CHAT_ROADMAP.md)
- [Email summary: alumni network implementation and cost](docs/ALUMNI_NETWORK_UPGRADE_EMAIL_BRIEF.md)
- Deployment guide: `docs/DEPLOYMENT_GUIDE.md`
- Deployment checklist: `docs/DEPLOYMENT_CHECKLIST.md`
- Health and monitor routes: `docs/MONITOR_ROUTES.md`
- Codebase optimization roadmap: `docs/CODEBASE_OPTIMIZATION_TODO.md`
- Scheduler health: `GET /api/system/scheduler` (see `docs/DEPLOYMENT_GUIDE.md` for the `schedulerEnabled` flag)

## Email configuration

- Configure one of the following in backend environment variables:
  - SYSTEM_EMAIL: preferred recipient for system emails (feedback, ops alerts). Recommended for staging/production.
  - SMTP_USER: used for SMTP auth and as fallback recipient when SYSTEM_EMAIL is not set.
- In test runs (NODE_ENV=test), sending emails is automatically skipped by the EmailService. Logs will include "Email skipped in test environment".

## Recurring Events: Auto-Reschedule Policy

When creating a recurring event series (every-two-weeks, monthly, every-two-months), the system enforces an Auto-Reschedule policy to avoid overlaps:

- For each desired occurrence after the first:

  - Try the desired date/time first.
  - If there’s a conflict, bump the start by +24 hours, up to 6 days.
  - If a free slot is found within those 6 days, schedule it and record it as “moved”.
  - If no free slot is found in that window, skip the occurrence for now. Each skipped occurrence is appended after the last scheduled one by advancing one cadence (e.g., +14 days for every-two-weeks; next month for monthly) and applying the same +24h up to 6-days bump rule.

- Cadence details:

  - every-two-weeks: +14 days from the prior start date
  - monthly / every-two-months: advance months first, then adjust forward to keep the same weekday as the first event

- Notifications:
  - The creator and any co-organizers receive a targeted system message summarizing moved, skipped, and appended occurrences.
  - Email notifications are sent with the same summary (skipped in test environments).

This policy ensures no overlapping occurrences while preserving the intended cadence and overall count (subject to availability within bump windows).
