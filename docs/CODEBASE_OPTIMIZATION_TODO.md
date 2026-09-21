# Codebase Optimization TODO

This is the living implementation plan for the cleanup, refactoring,
performance, and test-suite modernization work started in July 2026.

## Status

- Completed milestone: **Milestone 5 — structural simplification and final validation**
- Overall program status: **Complete — all planned cleanup, refactoring,
  performance, and test-modernization work is implemented and validated**
- Working branch: `main`
- Static validation: lint, type-check, deployment guardrails, focused-test
  guard, and the complete production build pass
- Fast-suite status: 6,010 backend unit/HTTP contracts and 1,883 frontend tests
  pass; there are no skipped or focused tests
- Full DB status: 181 files / 1,696 contracts pass in 378.05 seconds using
  isolated parallel worker databases
- Specialist tiers: 14 performance contracts pass in 5.15 seconds and three
  Playwright journeys pass in 3.6 seconds
- Coverage: backend 92.09% lines/statements, 91.59% functions, 86.67%
  branches; frontend 70.02% lines/statements, 49.04% functions, 73.03% branches
- Next action: review and commit the completed milestone set; no implementation
  item remains in this optimization plan

## Baseline

- Production TypeScript: approximately 157,000 lines
- Test TypeScript: approximately 299,000 lines
- Backend tests: 399 unit files and 180 integration files
- Frontend tests: 250 tracked files
- Frontend production bundle: 70 preloaded JavaScript chunks, approximately
  3.24 MiB raw / 0.92 MiB gzip
- Critical skipped tests: 36 skip declarations, concentrated in payments,
  promo codes, checkout, and webhooks

After Milestone 1:

- Removed 40 tracked files and 7,835 tracked lines, plus simplified two live
  modules
- Backend test files reduced from 579 to 575
- Frontend test files reduced from 250 to 241 while adding focused coverage for
  the corrected verification-resend path
- Frontend bundle reduced by 11,343 raw bytes / 2,453 gzip bytes; route loading
  remains the dominant bundle problem for Milestone 2

After Milestone 2A:

- Initial JavaScript reduced from approximately 70 eagerly loaded chunks to 4
  entry/shared chunks
- Initial JavaScript reduced from 3,390,662 to 745,688 raw bytes (78.0%) and
  from 966,473 to 232,033 gzip bytes (76.0%)
- PDF, spreadsheet, chart, admin, and protected-route chunks are no longer
  preloaded from `index.html`
- The full generated JavaScript graph is 112 chunks / 3,556,395 raw bytes /
  1,033,958 gzip bytes; route and action boundaries now determine which subset
  a user downloads

After Milestone 2B:

- Frontend production code now has one Socket.IO client creation path, with
  `useSocket` acting as the React lifecycle adapter for `socketService`
- Socket connections and event rooms are reference counted; event handlers use
  subscriber sets and can be removed independently
- Removed the duplicated realtime effect from `useEventData`, reducing that
  hook from 912 to 343 lines and leaving realtime behavior in one hook
- Initial JavaScript remains below target at 4 files / 749,590 raw bytes /
  232,943 gzip bytes
- Five shared image assets reduced from 1,452,625 to 207,192 bytes (85.7%)

After Milestone 3A:

- Uncached event-list reads now use a constant number of database operations:
  the projected page and total count run concurrently, followed by concurrent
  user-registration and active-guest aggregates; creator population adds one
  page-wide user lookup
- Event-list responses no longer hydrate the detail DTO, refetch every event,
  run capacity queries per role, generate slugs, or include participant records
- Event status transitions moved out of GET requests into a one-minute
  background refresh using one `bulkWrite` and one cache invalidation cycle
- Page size is capped at 100 and sort fields are allowlisted while preserving
  deterministic pagination tie-breakers

After Milestone 3B:

- Event-detail hydration now uses at most six page-wide database operations,
  independent of the number of roles and organizers; the former path grew by
  at least five operations per role plus one per organizer
- All event registrations are fetched and user-populated once, then grouped in
  memory; active guest occupancy is aggregated once by role and organizer
  contacts are refreshed with one optional batch query
- `CapacityService` no longer refetches Event documents and starts user and
  guest counts concurrently using capacity metadata already loaded by callers
- Detail GET requests no longer generate or persist public slugs; event creation
  and publishing remain the explicit slug-owning write paths
- On a 200-row explain fixture, the default paginated event query improved from
  200 keys and 200 documents examined plus a blocking `SORT` to 10 keys and 10
  documents examined with `LIMIT -> FETCH -> IXSCAN`

After Milestone 3C:

- Request monitoring has bounded raw samples, endpoint cardinality, IP and user
  agent sets, and minute buckets; request completion uses structured logging
  without synchronous filesystem writes or per-request start/end noise
- Program listing has deterministic database pagination with a default of 20
  and maximum of 100; on a 200-row fixture, the optimized first page examined
  20 keys and documents instead of 200 and avoided a blocking sort
- User search now uses the existing MongoDB text index, while retained partial
  searches escape regex input; audited read paths use explicit projections and
  `.lean()` where response semantics permit it
- JSON parsing middleware is instantiated once, and upload/avatar request paths
  use asynchronous filesystem operations; remaining synchronous filesystem
  setup is startup-only
- Direct production dependencies reduced from 36 to 22 by moving TypeScript,
  `ts-node`, and type-only packages to development dependencies
- Five affected backend test areas were rebuilt from 2,891 lines and 111 tests
  to 626 lines and 38 focused tests, removing 78.3% of their test code while
  adding boundary, query-plan, and frontend pagination coverage

After Milestone 4A:

- Split the backend into explicit unit, HTTP-contract, DB-integration, and
  performance configs; added a real Playwright browser tier and feature-risk
  protection matrix
- The DB-free backend tiers cover 388 files and 6,737 tests in roughly 43
  seconds locally; the frontend covers 238 files and 1,883 tests in roughly 40
  seconds
- Critical purchase, refund, and donation DB protection is 51 passing tests in
  27 seconds; three browser journeys pass in under four seconds; 14 performance
  contracts pass in under five seconds
- Removed all 72 skipped tests and 3,915 lines from stale payment/webhook
  facade suites while retaining passing critical workflow protection
- Parallel DB workers use isolated databases, reuse connections and indexes,
  clear data only at file boundaries, and clean only their run-owned databases
- Combined DB-free backend coverage passes at 91.44% lines/statements, 91.08%
  functions, and 88.02% branches; frontend coverage now has an honest
  full-application non-regression baseline instead of an impossible gate
- Restored CI as four parallel pull-request gates with the full DB suite on
  main/manual; removed seven placeholder/debug tests

After Milestone 5:

- Retired the forwarding controller layer and route-isolation duplicates;
  backend fast protection is now 336 unit files plus 29 HTTP-contract files
- Removed 138 tracked files, including 134 TypeScript/TSX files; the complete
  tracked diff removes 58,880 lines and adds 15,352, a net reduction of 43,528
  tracked lines before the new tier/config/report files are counted
- Current production TypeScript is 149,081 lines versus the approximately
  157,000-line audit baseline; current test TypeScript is 265,810 lines versus
  approximately 299,000, a roughly 11.1% reduction while adding browser,
  performance, HTTP-contract, and critical financial protection
- Backend routes now target focused controllers directly; aggregate controller
  and service barrels are removed and boundary lint prevents their return
- The frontend API surface is side-effect-free, notification/message clients
  share `BaseApiClient`, and shared timezone logic is a dual CommonJS/ESM npm
  workspace package consumed by both applications
- Arbitrary test sleeps are gone. The only remaining waits are explicit
  timeout, transient-backoff, and eventual socket-emission contracts
- Default test output is quiet with explicit verbose commands for diagnostics;
  thrown failures and assertions continue to surface normally
- Removed stale Netlify/Render-style TOML files while retaining the active
  Render blueprint, static rewrite artifacts, and deployment guardrail
- The final full matrix passes: 6,010 backend fast contracts, 1,883 frontend
  tests, 1,696 DB contracts, 14 performance contracts, and three browser
  journeys, with no skipped or focused tests

## Milestone 1 — Safe Cleanup Foundation

### Living plan and repository hygiene

- [x] Complete the read-only architecture, performance, and test audit
- [x] Create this living optimization TODO
- [x] Remove the stale tracked backend coverage-result artifact
- [x] Keep the tracked root package lock and stop ignoring lockfiles
- [x] Repair stale README and testing-document links
- [x] Re-run lint, type-check, build, and focused tests

### Confirmed dead backend code

- [x] Remove the unused middleware barrel and its tests
- [x] Remove the superseded validation-rules class and its tests
- [x] Remove the unused event-purchase service and its tests
- [x] Remove the unused auth utility module and its tests
- [x] Remove the unused email-types module
- [x] Remove unused imports and stale architecture comments
- [x] Remove the unreachable `EventConflictDetectionService` wrapper and its
  phantom controller mocks after preserving the live conflict endpoint

### Confirmed dead frontend code

- [x] Remove unreachable pages, components, hooks, and their tests
- [x] Remove the obsolete duplicate form components and tests
- [x] Remove deprecated guest-dashboard UI remnants
- [x] Replace mock-user verification resend with the real auth API
- [x] Remove frontend mock-user data from production
- [x] Remove the obsolete frontend email-notification service
- [x] Remove unused/deprecated notification-context APIs

## Milestone 2A — Frontend Loading

- [x] Convert route components to `React.lazy` with route-level `Suspense`
- [x] Remove manual page chunking that causes every page to be preloaded
- [x] Dynamically import `xlsx` only when exporting signups
- [x] Dynamically import `html2pdf.js` only when generating a receipt PDF
- [x] Keep Vite's shared preload/CommonJS helpers in the eager vendor chunk so
  lazy feature libraries cannot become accidental startup dependencies
- [x] Make routing tests await lazy pages and explicitly model guest auth state
- [x] Target: public/home initial JavaScript below approximately 250 KiB gzip,
  with no PDF, spreadsheet, chart, admin, or protected-route preload

## Milestone 2B — Realtime Consolidation

- [x] Consolidate `useSocket` and `socketService` into one client/provider
- [x] Support multiple subscribers per socket event
- [x] Remove duplicate realtime handling from `useEventData`
- [x] Use one reconnection strategy
- [x] Memoize provider values and stop mutating notification state during sort
- [x] Guard or remove production debug logging
- [x] Resize and compress default avatars and logos
- [x] Add focused lifecycle tests for connect, reconnect, multi-subscriber
  dispatch, room join/leave, and final-consumer disconnect
- [x] Target: one browser Socket.IO connection with deterministic subscription
  cleanup and no duplicate event processing

## Milestone 3 — Backend Query and Request Performance

### Milestone 3A — Event-list read path

- [x] Add a lightweight event-list DTO separate from event-detail responses
- [x] Batch registration and active-guest counts by event and role
- [x] Use database pagination instead of caching every matching event ID
- [x] Run event query and total count concurrently
- [x] Stop mutating event statuses during GET requests
- [x] Batch scheduled status updates and cache invalidation
- [x] Add a projection and `.lean()` to the event-list query
- [x] Preserve frontend card totals without shipping participant records
- [x] Allowlist sort fields and cap page size
- [x] Target: event-list query count constant per page rather than proportional
  to the number of events and roles

### Milestone 3B — Event-detail and capacity query path

- [x] Remove the duplicate Event existence lookup before detail hydration
- [x] Remove per-role Event refetches from `CapacityService`
- [x] Reuse the loaded event roles when computing detail capacity
- [x] Batch detail user and active-guest occupancy counts
- [x] Fetch role registrations once and group them in memory
- [x] Batch organizer contact refreshes instead of querying each organizer
- [x] Move lazy public-slug writes out of GET requests
- [x] Use query `explain()` results to add only the compound indexes justified
  by list/detail access patterns
- [x] Add constant-query regression coverage for event detail responses
- [x] Target: detail query count independent of role and organizer count

### Milestone 3C — Remaining request performance

- [x] Add projections and `.lean()` to remaining read-only queries
- [x] Paginate program listings
- [x] Escape user-search input and adopt an indexed search strategy
- [x] Replace the high-cardinality request monitor with bounded metrics
- [x] Remove synchronous request-path filesystem writes
- [x] Instantiate JSON middleware once instead of once per request
- [x] Move build-only backend packages and type packages to dev dependencies

## Milestone 4 — Test Harness Rebuild

### Protection model

- [x] Build a feature-risk matrix for auth, permissions, events, guests,
  programs, payments, refunds, donations, promo codes, notifications, uploads,
  and analytics
- [x] Map retained tests to product contracts before pruning
- [x] Replace skipped financial-flow tests with a small passing critical set

### Test tiers

- [x] Create explicit `unit`, `http-contract`, `db-integration`,
  `browser-e2e`, and `perf` tiers
- [x] Move DB-free Supertest tests out of the DB integration tier
- [x] Use a unique test database per database worker
- [x] Connect once per worker and clean at controlled suite boundaries
- [x] Remove blanket per-test database deletion and arbitrary cleanup sleeps
- [x] Enable file parallelism after shared-state pollution is removed
- [x] Replace the frontend global setup with small opt-in fixtures
- [x] Stop globally mocking the entire frontend API barrel
- [x] Replace real delays with fake timers and deterministic deferred promises

### Test pruning and coverage

- [x] Remove tests that protect deleted modules and compatibility barrels
- [x] Consolidate facade-controller tests with extracted-controller tests
- [x] Replace repetitive financial branch blocks with focused behavior and DB
  workflow tests
- [x] Silence expected console output by default while retaining explicit
  verbose diagnostics and normal thrown-error/assertion reporting
- [x] Give unit and integration coverage separate output directories
- [x] Measure combined unit/contract coverage in one process
- [x] Keep coverage thresholds in one configuration source
- [x] Make frontend coverage non-watch with `vitest run --coverage`
- [x] Add a real Playwright suite for the critical user journeys
- [x] Run performance and index tests separately
- [x] Restore parallel PR CI and main/manual full-DB protection
- [x] Target: normal PR protection in under three minutes with no skipped
  critical financial tests

## Milestone 5 — Structural Simplification

- [x] Route directly to specialized controllers and retire compatibility facades
- [x] Replace backend service/controller barrels with direct imports
- [x] Make the frontend API aggregate side-effect-free and keep required
  compatibility aliases at their owning service-module boundaries
- [x] Consolidate notification and message clients on the shared API client
- [x] Turn shared time logic into a dual CommonJS/ESM workspace package
- [x] Adopt npm workspaces for reproducible installation and orchestration
- [x] Add dependency-boundary lint rules to prevent new legacy imports
- [x] Verify deployment manifests, remove stale TOML files, and retain the
  active Render/static-SPA contracts

## Milestone History

### Milestone 4B/5 — Test hygiene and structural simplification (completed 2026-07-10)

Completed:

- Routed auth, programs, promo codes, analytics, guests, events,
  notifications, users, purchases, and email notifications directly to their
  focused controllers; removed forwarding facades, their duplicate tests, and
  the controller/service aggregate barrels
- Reduced `EventController` to shared event-domain helpers and
  `UnifiedMessageController` to its internal targeted-message gateway; removed
  dynamic controller loading from event creation
- Simplified the frontend API index into a pure export surface and moved its
  two required aliases to their owning modules; consolidated notification and
  system-message HTTP behavior on `BaseApiClient`
- Added the `@atcloud/shared-time` workspace with conditional CommonJS/ESM
  exports, root workspace orchestration, fresh-build Playwright wiring, and
  direct backend/frontend package consumption
- Replaced arbitrary UI loading sleeps with deterministic deferred promises or
  fake timers; removed DB cleanup sleeps, request pacing, and obsolete parser
  retries; deleted an unused integration resource manager
- Made expected test console output quiet by default and added explicit verbose
  diagnostics, while leaving failures and assertions visible
- Added boundary lint for retired backend barrels/facades and frontend API
  internals; corrected its exact-path matching so concrete modules remain legal
- Removed stale `frontend/render.toml` and `frontend/public/netlify.toml` after
  verifying that `render.yaml`, `static.json`, `_redirects`, and deployment
  guardrails own the active hosting contract
- Fixed regressions found by the final matrix: invalid message IDs now return
  400 at specialized controllers, strict publish validation is evaluated at
  request time, upload fixtures are valid and worker-isolated, and the shared
  package exposes a browser-compatible ESM build
- Completed a final unused-export and reachability pass: removed three legacy
  message controllers, the unused event-conflict wrapper, orphaned error and
  validation services, an unused transaction-history manager, and a dormant
  runtime notification-config updater/validator
- Removed the self-referential unit suites for those orphans and two superseded
  legacy message-route suites while retaining and rerunning the current
  conflict, message read/delete, and cleanup endpoint contracts

Validation:

- `npm run verify:local` — lint, type-check, deployment guardrails, and
  focused-test guard passed
- `npm run build` — shared dual build, backend build, and optimized frontend
  production build passed
- Backend fast coverage — 365 files / 6,010 tests passed in 46.41 seconds;
  92.09% lines/statements, 91.59% functions, 86.67% branches
- Frontend unit — 238 files / 1,883 tests passed in 37.91 seconds
- Frontend coverage — 238 files / 1,883 tests passed in 65.02 seconds;
  70.02% lines/statements, 49.04% functions, 73.03% branches
- Full DB integration — 181 files / 1,696 tests passed in 378.05 seconds
- Performance — 3 files / 14 contracts passed in 5.15 seconds
- Playwright — 3 critical journeys passed in 3.6 seconds
- `git diff --check` and skipped/focused-test scans — passed

Status quo:

- All planned optimization milestones are complete and the full validation
  matrix is green
- Pull-request protection remains lightweight and parallel; the six-minute
  database suite is reserved for main/manual while critical financial DB
  flows remain in the PR tier
- Public compatibility is preserved at API boundaries, while internal module
  ownership is explicit and guarded against regression
- No further code change is required for this plan; the next operational step
  is a human diff review followed by an intentional commit/PR

### Milestone 3C — Remaining request performance (completed 2026-07-10)

Completed:

- Replaced the unbounded request monitor with capped raw retention, endpoint
  aggregation, normalized route labels, bounded unique-value samples, and
  minute buckets that retain accurate hourly totals after raw samples roll off
- Removed synchronous request-path log/file operations and per-request console
  chatter; uploads create directories asynchronously and avatar cleanup uses
  promise-based unlink with structured error handling
- Reused one Express JSON parser instead of constructing middleware for every
  request
- Added deterministic, capped program pagination, an explicit projection, and
  compound indexes for the measured default and program-type access paths;
  preserved the frontend array contract through a bounded compatibility adapter
- Added shared search normalization and escaping, moved user/admin/owner search
  onto the existing User text index, escaped retained event/program regexes, and
  corrected event date filtering to match the schema's `YYYY-MM-DD` strings
- Added explicit projections and `.lean()` to the audited user, program, promo
  owner, donation-user, and global-search read paths, with independent reads and
  counts started concurrently
- Moved 12 type packages plus TypeScript and `ts-node` out of production
  dependencies and regenerated the backend lockfile
- Rebuilt the request-monitor, search, program-list, and avatar-cleanup unit
  suites around contracts and boundary cases; removed a redundant emergency
  monitor suite and added program API and MongoDB winning-plan coverage
- Repaired the backend test-lint configuration for the installed
  `typescript-eslint` version while retaining legacy test debt as warnings for
  the dedicated Milestone 4 cleanup

Validation:

- `npm run lint` — passed
- `npm run type-check` — passed
- `npm run build` — passed
- `npm run check:no-only` — passed
- Backend `npm run lint:tests` — passed with the existing warning backlog
- 169 affected backend unit tests — passed
- 164 affected API/database/index-plan integration tests — passed
- 2 frontend program API compatibility tests — passed
- Seeded program explain comparison for 20 results from 200 matching programs:
  200 keys / 200 documents plus `SORT` before; 20 keys / 20 documents and no
  blocking `SORT` after
- Seeded User text-search explain used `TEXT_MATCH` and `IXSCAN`, with no
  collection scan
- `npm ls --omit=dev --depth=0` — passed with 22 direct runtime dependencies
- `git diff --check` — passed

Status quo:

- Request instrumentation has fixed memory/cardinality bounds and no longer
  performs synchronous request-path I/O; only startup directory setup remains
  synchronous
- Program APIs expose page metadata and cap each page at 100; the legacy
  frontend adapter intentionally consumes one bounded page of up to 100 until a
  paginated program-list UI is warranted
- User search now has indexed token-search semantics; event and program partial
  matching remains compatible but safely escapes input
- The focused 3C suites are substantially smaller, but the broader test harness
  still mixes tiers, performs redundant database cleanup, and contains skipped
  critical financial coverage; that is the scope of Milestone 4
- The worktree contains the intended Milestone 1, 2A, 2B, 3A, 3B, and 3C
  changes
- The next highest-value work is Milestone 4's protection matrix and explicit
  test tiers, beginning by separating DB-free HTTP contracts from database
  integration tests

### Milestone 3B — Event-detail and capacity query path (completed 2026-07-09)

Completed:

- Removed the controller's duplicate Event existence query and made the detail
  builder the single owner of Event hydration
- Replaced per-role registration queries, user populations, guest counts, and
  Event refetches with one projected registration fetch, one page-wide user
  population, and one active-guest aggregation grouped by role
- Grouped and sorted registrations once in memory while preserving participant
  ordering, privacy filtering, role counts, notes, and special requirements
- Replaced per-organizer user lookups with one deduplicated batch lookup
- Changed `CapacityService` to accept already-loaded role capacity, count users
  and guests concurrently, and avoid every Event refetch; updated all production
  callers to pass their loaded capacity metadata
- Changed event-wide signup counts to two occupancy aggregates plus an optional
  role projection, with support for reusing roles already loaded by the caller
- Removed lazy public-slug generation and persistence from detail GETs; creation
  and publishing continue to generate missing slugs in explicit write flows
- Added `{ status: 1, date: 1, time: 1, _id: 1 }` for the measured default list
  access path and retained the existing detail indexes after explains confirmed
  `eventId_1` for registrations and `eventId_1_status_1` for active guests
- Rebuilt repetitive capacity tests around behavior and concurrency, and added
  constant-query detail and explain-plan regression coverage

Validation:

- `npm run lint` — passed
- `npm run type-check` — passed
- `npm run build` — passed
- `npm run check:no-only` — passed
- 397 affected capacity, detail-builder, event-controller, public-registration,
  and guest-controller unit tests — passed
- 54 event API, public detail/capacity, registration-field, registration-note,
  and index-plan integration tests — passed
- Seeded explain comparison for 10 results from 200 matching events: 200 keys /
  200 documents plus `SORT` before; 10 keys / 10 documents and no blocking
  `SORT` after
- `git diff --check` — passed

Status quo:

- Event detail now has constant query cardinality: Event and creator hydration,
  one registration/user fetch, one active-guest aggregation, and at most one
  organizer batch lookup, for a maximum of six database operations
- Role and organizer growth now affects only in-memory grouping and response
  size, not database round trips
- Capacity checks in mutation paths still perform live user and guest counts,
  but those two counts run concurrently and no longer refetch Event documents
- Registration and guest detail access already use suitable indexes, so no
  redundant detail-specific indexes were added
- The worktree contains the intended Milestone 1, 2A, 2B, 3A, and 3B changes
- The next highest-value work is Milestone 3C, beginning with bounded request
  metrics and removal of synchronous request-path overhead before program-list
  pagination and indexed user search

### Milestone 3A — Event-list read path (completed 2026-07-09)

Completed:

- Replaced the production all-ID ordering cache with real database pagination,
  a list-only projection, `.lean()`, deterministic sorts, and a maximum page
  size of 100
- Ran the event page query and matching count concurrently and replaced
  per-event detail hydration with two page-wide occupancy aggregates
- Added a list-specific response contract that keeps organizer/card metadata
  and accurate role totals while excluding registration and participant data
- Updated the frontend adapter to trust server-provided `signedUp` and
  `totalSlots` values when list roles intentionally contain empty participant
  arrays
- Extracted pure event-status derivation, removed status writes from list and
  detail GET requests, and scheduled a one-minute background refresh
- Changed scheduled status persistence to one `bulkWrite` and one shared event
  plus analytics cache invalidation cycle
- Removed the obsolete event-ordering cache helper and its redundant test

Validation:

- `npm run lint` — passed
- `npm run type-check` — passed
- `npm run build` — passed
- `npm run check:no-only` — passed
- 312 affected backend unit/facade tests — passed
- 69 event-list, sorting, pagination, program-label, and events API integration
  tests — passed
- Frontend list-summary compatibility test — passed
- A broad backend unit run exposed the already-audited route-test harness
  problem: nominal unit files that open Supertest ports fail with `port` being
  null; affected event facade assertions were updated and pass independently
- `git diff --check` — passed

Status quo:

- An uncached event-list page now has constant query cardinality rather than a
  cost that grows with every event, role, organizer, and registration payload
- Cached list responses retain the existing two-minute cache behavior and
  mutation invalidation contract
- Detail responses still use `RegistrationQueryService` and
  `CapacityService`, where each role performs registration, guest, and Event
  lookups; this is the highest-value query target for Milestone 3B
- The worktree contains the intended Milestone 1, 2A, 2B, and 3A changes

### Milestone 2B — Realtime Consolidation (completed 2026-07-09)

Completed:

- Replaced the independent `useSocket` connection with a lifecycle adapter over
  the singleton socket service; production now contains exactly one `io()` call
- Added final-consumer connection cleanup with a StrictMode-safe grace period,
  token-aware socket replacement, and independently removable subscriber sets
- Added reference-counted event rooms that rejoin automatically after Socket.IO
  reconnects without a competing custom reconnect loop
- Collapsed identical global-plus-room event deliveries by event id, update
  type, and server timestamp so one backend update is processed once
- Removed 568 lines of duplicated EventDetail realtime behavior from
  `useEventData`; `useRealtimeEventUpdates` is now the sole event-detail handler
- Removed realtime debug logging, memoized notification context values, and
  changed notification sorting to operate on a copy instead of mutating state
- Resized and compressed the two default avatars and three shared logos/icons
  without changing their public paths or visual identity
- Updated stale socket mocks and added direct lifecycle coverage for shared
  connections, multi-subscriber dispatch, duplicate suppression, room
  reference counting, reconnect rejoin, and token replacement

Validation:

- `npm run lint` — passed
- `npm run type-check` — passed
- `npm run build` — passed
- `npm run check:no-only` — passed
- 97 socket-dependent frontend tests across 41 files — passed
- Initial bundle inspection — 4 JavaScript files / 749,590 raw bytes / 232,943
  gzip bytes; the Milestone 2A loading target remains satisfied
- Shared image assets — reduced by 1,245,433 bytes (85.7%)
- `git diff --check` — passed

Status quo:

- Realtime connection ownership, reconnect behavior, subscriptions, and event
  room lifecycle now have one implementation and focused regression protection
- The frontend still receives duplicate global-plus-room event packets from the
  backend, but the shared client deterministically processes each timestamped
  update once; removing the redundant server broadcast can be considered with
  backend work
- The worktree contains the intended Milestone 1, 2A, and 2B changes
- The next highest-value work is Milestone 3's event-list query and request-path
  performance work

### Milestone 2A — Frontend Loading (completed 2026-07-09)

Completed:

- Converted all route pages and route-only layout/access components to lazy
  imports behind a shared route-level suspense fallback
- Removed page/admin/analytics manual chunk rules that made lazy page chunks
  eager dependencies of the entry document
- Deferred XLSX parsing until a signup export is requested and deferred the PDF
  engine until a receipt download is requested
- Pinned Vite's shared preload helper to the core vendor chunk after the first
  build revealed that it was otherwise pulling the 896 KB PDF chunk into every
  startup
- Updated routing coverage for asynchronous page resolution, explicit guest
  state, and unambiguous page-heading assertions

Validation:

- `npm run lint` — passed
- `npm run type-check` — passed
- `npm run build` — passed, including the final optimized frontend build
- `npm run check:no-only` — passed
- 26 focused routing and event-detail tests — passed
- Initial bundle inspection — 4 JavaScript files / 745,688 raw bytes / 232,033
  gzip bytes; no PDF, spreadsheet, chart, admin, or protected-route preload

Status quo:

- Milestone 2A achieved the startup target with a 76.0% gzip reduction
- Total generated chunk count increased because routes are now isolated, while
  the browser initially requests only the entry and three shared vendor chunks
- Milestone 2B subsequently consolidated realtime ownership and lifecycle
- The worktree contains the intended Milestone 1, 2A, and 2B changes

### Milestone 1 — Safe Cleanup Foundation (completed 2026-07-09)

Completed:

- Removed confirmed dead backend middleware, validation, auth, purchase, and
  type modules together with tests that protected only those modules
- Removed unreachable frontend pages, components, hooks, mock data, obsolete
  notification/email logic, and their tests
- Replaced browser-generated verification tokens and mock-user lookup with
  `authService.resendVerification`
- Removed unused notification-context APIs and stale architecture comments
- Removed the 2.4 MB tracked historical coverage result
- Repaired active documentation links and lockfile policy

Validation:

- `npm run lint` — passed
- `npm run type-check` — passed
- `npm run build` — passed
- `npm run check:no-only` — passed
- 43 focused frontend/backend tests — passed
- `git diff --check` — passed

Status quo:

- This milestone's changes remain in the worktree together with Milestones 2A
  and 2B
- No broad integration/full-suite claim is made; MongoDB-independent tests are
  still coupled to integration DB setup
- Route-level loading and realtime consolidation are now complete; backend
  query and request-path performance is next
