# @Cloud Alumni Network Upgrade — Implementation Brief

**Suggested subject:** Approved Scope and Delivery Plan for the @Cloud Alumni Network Upgrade
**Version:** 2.4
**Prepared:** September 10, 2026
**Updated:** September 21, 2026
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
Accepted Request, outcome, and timeline records remain for 12 months after close, with an additional
30-day safeguard after the latest outcome deadline.

### Chat Rooms, Program Rooms, and notifications

MongoDB stores durable history, Socket.IO delivers persisted messages in real time, and REST cursors
restore missed messages. Rooms support text/safe links, send state, retry, read state, unread,
mute/unmute, and responsive layouts.

Each enabled Program has one primary Room. Active, verified access follows active enrollment,
effective purchase-derived enrollment, and current Program assignments. Membership sources are
merged by user ID. Unenrollment closes the relevant enrollment entitlement; the active access window
closes when the last eligible source ends and the Room moves to Past / Read-only. Regaining eligibility
after that closure opens a new window. Historical reads use authorized windows, while sending,
unread, Socket, announcements, Program updates, and Push/email recipients use the current active
window. Program pages provide Open Chat Room, and Program closure archives the Room.

Current Mentors, Class Representatives, and enrolled Mentees with Leader authorization or above can
publish Program announcements. The server recalculates authorization and recipients at publication.

Notification numbers appear at these locations:

- Chat Rooms navigation: unread member messages and Program announcements across accessible Rooms.
- Room row: unread messages and announcements in that Room.
- System Messages navigation: unread ERP and workflow notices.
- Alumni Community sidebar and Help Requests navigation: unique requests with an unread update from the other participant or an action needed; each request counts once.
- PWA launcher icon: Chat Rooms unread plus System Messages unread.

Room notifications open the relevant Chat Room. Help workflow notifications open the relevant Help
Request. Login recovery preserves the destination. Room mute controls Room Push/email delivery; Help
and result events follow the member's global channel preferences.
Every Help workflow step updates the page and badges in real time. The default Updates view includes
new progress and outcome confirmations. Opening a request marks the displayed update as read;
requests still requiring action remain counted. Reconnection, returning to the page, and a 15-second
foreground recovery check restore missed updates.
Room read state, System Message read state, and Help updates/read state/action completion update their respective counts.

### Website and PWA

One React codebase delivers desktop, phone-browser, and installable PWA access. It includes the
manifest/icons, standalone launch, Service Worker/offline/update flow, Android and iPhone/iPad install
UX, Web Push, preferences, deep links, login recovery, email fallback, iPhone/iPad/desktop real-device
qualification, and Android browser automation.

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
   migrations, approved record-specific retention and capacity limits, monitoring, accessibility,
   load, and operational recovery tests.

The exact field, retention, capacity, Program-mapping, and deployment contracts are maintained in the
[approved parameter registry](ALUMNI_NETWORK_APPROVED_PARAMETERS.md).

## 3. Architecture and cost

`React website/PWA on Render Static Site → Node/Express/Socket.IO and workers on Render Web Service → MongoDB Atlas`, with Push and email adapters.

The approved launch configuration keeps the Render Static Site and Starter Web Service and uses the
existing Atlas Free cluster.

| Launch services | Monthly planning view |
| --- | --- |
| Core configuration | Existing Render services + Atlas Free `$0` database subscription |
| Additional services | Actual workspace, email, domain, bandwidth, storage, Push, and other usage |

Launch qualification verifies production data and indexes fit within the Atlas Free storage limit and
that the existing transaction, migration, outbox, and audit workflows operate on that cluster. Render
and Atlas capacity are reassessed if usage or performance approaches the Free limits. Data loss or
corruption may be irreversible on this configuration; Travis accepted this launch risk.

Published references: [Render plans and pricing](https://render.com/pricing),
[Render workspaces](https://render.com/docs/platform-features-by-plan),
[MongoDB Atlas pricing](https://www.mongodb.com/pricing).

## 4. Release

Release readiness requires security/data, workflow/messaging, device, accessibility, capacity, and
operational recovery evidence for the applicable roadmap tasks.

M0–M6 are enabled together in one production release for every user who meets the corresponding
permissions. Production monitoring and user feedback drive debugging and improvement.

Additional implementation items enter the roadmap after Travis approves their user, technical,
schedule, and cost impact.
