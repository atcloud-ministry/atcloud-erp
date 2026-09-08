# @Cloud Alumni Network Upgrade — Implementation Brief

**Suggested subject:** Approved Scope and Delivery Plan for the @Cloud Alumni Network Upgrade
**Version:** 2.2
**Prepared:** September 8, 2026
**Project leads:** Sam Ma, Executive Director; Travis Fan, Assistant Director of IT and Website

This upgrade adds an alumni directory, structured help workflows, private and Program chat rooms,
responsive web access, an installable PWA, notifications, and measurable help outcomes to the ERP.

## 1. Member experience

### Community and Directory

| Destination | Route | Delivery |
| --- | --- | --- |
| Alumni Directory / Profile | `/dashboard/community/alumni` and profile routes | Search, cards, profile publishing, and Request Help |
| Members | `/dashboard/community/members` | Privacy-safe member directory |
| Help Requests | `/dashboard/community/help-requests` | Request lists, status, results, and Help Room access |
| Chat Rooms | `/dashboard/chat-rooms` | Private Alumni Help Rooms and Program Rooms |
| System Messages | `/dashboard/system-messages` | ERP system and workflow notices |
| User Management | `/dashboard/admin/users` | Existing authorized account-management functions |

Community opens Alumni Directory and uses the same name for all active, verified members.
Administration gives authorized staff access to User Management. Chat Rooms is a separate top-level
destination with a conversation-bubble icon. Existing links redirect to the routes above.

Approximately 322 alumni records pass through account matching, eligibility review, invitation, and
claim. An active, verified alumnus with valid consent and a verified affiliation can publish a profile. Cards
show identity, professional summary, general location, cohort, three offering states, and Request
Help. Search covers those fields. Career Advice, Warm Introduction, and Formal Employee Referral are
enabled independently, and Request Help displays the member's current offerings.

### Alumni Help and results

A request contains the alumni profile, selected help type, optional short opening note, consent
version, and disclaimer version. The server derives the requester from the signed-in account.

The provider can request information, accept, decline, or propose another enabled type. The requester
can supply information and confirm or reject the alternative. Acceptance creates a private two-person
Help Room. Help Requests shows action groups, requested/proposed/agreed type, lifecycle and result
timelines, and the Room link.

The help recipient records the final result:

| Agreed help type | Available result |
| --- | --- |
| Career Advice | Did not take place; Completed |
| Warm Introduction | Did not take place; Completed |
| Formal Employee Referral | Did not take place; Interview obtained but not hired; Interview successful and ultimately hired |

Each submission is an immutable revision. The provider can Confirm or Deny it; pending revisions are
confirmed automatically after 480 hours. Denial lets the recipient submit a new revision and starts a
new period. Every action enters the audit history, and accepted requests support result recording
throughout the approved retention period.
Pending 480-hour deadlines remain scheduled when a Request is completed/closed or its Room is archived.

### Chat Rooms, Program Rooms, and notifications

MongoDB stores durable history, Socket.IO delivers persisted messages in real time, and REST cursors
restore missed messages. Rooms support text/safe links, send state, retry, read state, unread,
mute/unmute, and responsive layouts.

Each enabled Program has one primary Room. Active, verified access follows active enrollment,
effective purchase-derived enrollment, and current Program assignments. Unenrollment closes every
active entitlement and the access window at the last visible message, then moves the Room to Past /
Read-only; re-enrollment opens a new window. Historical reads use authorized windows, while sending,
unread, Socket, announcements, Program updates, and Push/email recipients use the current active
window. Program pages provide Open Chat Room, and Program closure archives the Room.

Current Mentors, Class Representatives, and enrolled Mentees with Leader authorization or above can
publish Program announcements. The server recalculates authorization and recipients at publication.

Notification numbers appear at these locations:

- Chat Rooms navigation: unread member messages and Program announcements across accessible Rooms.
- Room row: unread messages and announcements in that Room.
- System Messages navigation: unread ERP and workflow notices.
- Help Requests navigation: unique requests requiring the user's action.
- PWA launcher icon: Chat Rooms unread plus System Messages unread.

Room notifications open the relevant Chat Room. Help workflow notifications open the relevant Help
Request. Login recovery preserves the destination. Room mute controls Room Push/email delivery; Help
and result events follow the member's global channel preferences.
Room read state, System Message read state, and Help action completion update their respective counts.

### Website and PWA

One React codebase delivers desktop, phone-browser, and installable PWA access. It includes the
manifest/icons, standalone launch, Service Worker/offline/update flow, Android and iPhone/iPad install
UX, Web Push, preferences, deep links, login recovery, email fallback, and real-device qualification.

## 2. Code delivery

1. **Registration/KPI:** private phone, birth year, structured residence and employment fields,
   existing-user completion, migration, and privacy-safe analytics.
2. **Community/Directory:** routes, redirects, profile/consent/affiliation data, roster import,
   invitation/claim, cards, search, Members, and User Management entry.
3. **Data boundaries:** `/api/directory` returns Directory DTOs, `/api/community/members` returns
   CommunityMemberDTO, and `/api/admin/users` returns AdminUserDTO under the existing permission.
   Purpose-scoped UserPickerDTO APIs and server-side contact resolution replace broad user lookups;
   Analytics uses aggregate DTOs. Existing `/api/users` consumers migrate to these APIs with
   authorization/PII regression coverage.
4. **Alumni Help:** request workflow, alternatives, private Room creation, seven outcomes, immutable
   revisions, 480-hour confirmation, notifications, action counts, and audit history.
5. **Messaging/Programs:** models, persistence, Socket/REST delivery, access windows, unread counts,
   responsive UI, Program membership, announcements, archive, and notifications.
6. **PWA/delivery:** manifest, Service Worker, Push subscriptions, VAPID, preferences, badges, deep
   links, email fallback, and device installation UX.
7. **Reliability/release:** authorization, validation, indexes, idempotency, durable outbox,
   migrations, audit, retention, monitoring, accessibility, load, backup/restore, and recovery tests.

## 3. Architecture and cost

`React website/PWA on Render Static Site → Node/Express/Socket.IO and workers on Render Web Service → MongoDB Atlas`, with Push and email adapters.

The repository confirms a Render Static Site and Starter Web Service. Invoice and dashboard review
will establish the exact Atlas tier, workspace, email, domain, bandwidth, and usage baseline.

| Operating scenario | Monthly planning view |
| --- | --- |
| Current known configuration | Static Site compute `$0` + Starter backend about `$7` + actual Atlas/workspace/email/domain/usage |
| Development and qualification | Current service shape: about `$7` with Atlas Free or about `$15–$37` with Atlas Flex |
| Recovery-oriented production | Starter + Atlas Dedicated from about `$63.94+`, or Standard + Atlas Dedicated from about `$81.94+`, plus workspace and variable services |

A Render Pro workspace adds approximately `$25/month` when selected for the operating model.

Current plans remain when load and recovery measurements meet the approved targets. Render moves from
Starter to Standard when testing or monitoring shows sustained CPU, memory, latency, restart, or
worker-backlog pressure after query/index optimization. Atlas moves to Dedicated when the approved
recovery objective calls for continuous backup, point-in-time restore, or another Dedicated feature.

Published references: [Render plans and pricing](https://render.com/pricing),
[Render workspaces](https://render.com/docs/platform-features-by-plan),
[MongoDB Atlas pricing](https://www.mongodb.com/pricing), and
[Atlas Flex costs](https://www.mongodb.com/docs/atlas/billing/atlas-flex-costs/).

## 4. Release

Release readiness requires security/data, workflow/messaging, device, accessibility, capacity, and
recovery evidence for every roadmap task.

M0–M6 are enabled together in one production release for every user who meets the corresponding
permissions. Production monitoring and user feedback drive debugging and improvement.

Additional implementation items enter the roadmap after Travis approves their user, technical,
schedule, and cost impact.
