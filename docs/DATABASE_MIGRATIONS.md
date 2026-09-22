# Versioned Database Migrations

## Migration contract

Each production migration is a file named
`backend/src/migrations/versions/YYYYMMDD_NNN_kebab-slug.ts` with these fields:

- `id`: `YYYYMMDD_NNN_kebab-slug`, unique and strictly increasing.
- `description`: one safe, single-line description.
- `plan`: read-only impact/count calculation with structured warning codes/counts.
- `up`: one bounded forward batch.
- `down`: one bounded reverse batch.
- `verify`: terminal postcondition verification.

The checksum command validates each source file, computes a domain-separated
SHA-256 from its filename and LF-normalized UTF-8 content, and generates the
ordered static registry. `plan` receives a read-only database adapter. `up` and
`down` receive a transaction-bound write adapter; `verify` receives a
transaction-bound read-only adapter. Domain writes, lease fencing, terminal
verification, and ledger progress commit in the same transaction.

Forward and rollback progress use separate bounded JSON checkpoints. The final
forward checkpoint remains available to `down` and `verify` as
`appliedCheckpoint`.

`build`, `migration`, and `migration:dev` run a quiet checksum freshness gate
before migration code is loaded.

## Commands

From `backend/` during development:

```bash
npm run -s migration:checksums:update
npm run -s migration:checksums:check
npm run -s migration:dev -- status --json
npm run -s migration:dev -- dry-run --to 20260909_001_example --json
npm run -s migration:dev -- apply --to 20260909_001_example --execute --yes --confirm-db DATABASE_NAME --operator NAME --json
npm run -s migration:dev -- resume 20260909_001_example --execute --yes --confirm-db DATABASE_NAME --operator NAME --json
npm run -s migration:dev -- rollback 20260909_001_example --reason-code POSTCONDITION_FAILED --execute --yes --confirm-db DATABASE_NAME --operator NAME --json
```

After `npm run build`, use the compiled command:

```bash
npm run -s migration -- status --json
```

Every write command requires `--execute`, `--yes`, the exact connected database
name, and an operator supplied by `--operator` or `MIGRATION_OPERATOR`.

From the Render service's repository-root one-off job, use the compiled entrypoint:

```bash
node backend/dist/scripts/migrations/runMigrations.js apply --to 20260909_001_example --execute --yes --confirm-db DATABASE_NAME --operator NAME --json
```

`--json` returns version IDs, statuses, aggregate counts, timestamps, and stable
issue/error/warning codes. Use `npm run -s` or the direct compiled entrypoint so
npm lifecycle banners do not contaminate JSON output or echo command arguments.

Rollback accepts one of these reason codes: `POSTCONDITION_FAILED`,
`DATA_VALIDATION_FAILED`, `RELEASE_ROLLBACK`, `MIGRATION_REPLACED`, or
`OPERATOR_REQUEST`.

## Execution workflow

1. Build the exact release commit that contains the migration.
2. Run `status --json` and resolve every reported ledger issue.
3. Run `dry-run --to ID --json` and review counts and warnings.
4. Run the compiled `apply --to ID` command as a Render one-off job.
5. Run `status --json` and retain the release output.
6. Use `resume ID` for the recorded recovery point, or `rollback ID` for the
   latest applied/recovery version.

The permanent `schema_migrations` ledger records version, checksum, direction,
apply/rollback checkpoints, aggregate counts, attempt, operator, release
version, timestamps, rollback reason code, and sanitized failure metadata. The
`schema_migration_locks` document provides a single global lease with a monotonic
fence. A crashed run becomes resumable after its lease expires. `status` returns
exit code 3 when integrity issues or a recovery point require action; an
interrupted CLI run returns a nonzero exit code.

## Author checklist

- Use `_id` keyset pagination and a fixed high-watermark for source rows.
- Keep each batch below the configured transaction and lease duration.
- Use field preconditions or revisions so concurrent user edits become conflicts.
- Return an advanced checkpoint for every incomplete batch.
- Return zero row errors before a batch can commit.
- Make `up` and `down` safe to re-enter from the last committed checkpoint.
- Make `down` restore only values still owned by the migration.
- Add dry-run, interruption/resume, verification, rollback, and rerun tests using
  the MongoDB replica-set integration suite.
- Keep `plan` read-only and return warning codes/counts without source data.
- Structure each version file with type-only relative imports/exports, local
  types/interfaces, and one `export const migration` literal with inline
  `plan`, `up`, `down`, and `verify` handlers.
- Return plans, counts, warnings, and verification through the structured
  handler results.
- Run `migration:checksums:update` after adding or changing a version source and
  commit the generated manifest with it.
- Limit migration authorship to trusted, code-reviewed repository contributors.

`MONGODB_URI` is supplied through the environment. The CLI uses an isolated
connection with Mongoose `autoCreate` and `autoIndex` disabled.
