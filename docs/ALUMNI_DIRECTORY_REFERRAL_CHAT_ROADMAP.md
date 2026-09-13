# @Cloud ERP Alumni Network 升级路线图

## 文档状态

- 版本：3.9
- 更新时间：2026-09-12
- 状态：Approved
- 实施进度：M0–M6 已完成
- 下一任务：G1-01（待确认）
- Executive Director：Sam Ma
- 技术与实施联系人：Travis Fan，Assistant Director of IT and Website
- 新增事项经 Travis 批准并登记为 `ADD-xxx` 后进入实施清单。

任务完成时把 `[ ]` 改为 `[x]`，并在该任务后附验证证据。

## 1. 交付定义

### 1.1 页面与导航

| 页面 | Route | 交付内容 |
| --- | --- | --- |
| Community | `/dashboard/community` | 默认打开 Alumni Directory |
| Alumni Directory | `/dashboard/community/alumni` | 搜索和浏览 alumni cards |
| Alumni Profile | `/dashboard/community/alumni/:profileId` | 公开资料与 Request Help |
| My Alumni Profile | `/dashboard/community/alumni/me` | 编辑、预览、同意发布、发布和撤回 |
| Members | `/dashboard/community/members` | 社区成员目录 |
| Help Requests | `/dashboard/community/help-requests` | Action needed、Received、Sent、Completed |
| Help Request Detail | `/dashboard/community/help-requests/:requestId` | 请求、结果、时间线和 Help Room |
| Chat Rooms | `/dashboard/chat-rooms` | Alumni Help Rooms 与 Program Rooms |
| Chat Room | `/dashboard/chat-rooms/:conversationId` | 聊天历史与消息输入 |
| System Messages | `/dashboard/system-messages` | ERP 系统与工作流通知 |
| User Management | `/dashboard/admin/users` | 现有账号管理功能 |

`Community` 对 active + verified ERP members 使用统一名称和页面。拥有现有
account-management permission 的用户同时看到 `Administration → User Management`。
`Chat Rooms` 是独立顶级标签，使用对话泡泡 icon。

生产链接使用 HashRouter 格式 `/#/dashboard/...`。`/dashboard/management` 按 account-management
permission 跳转至 User Management 或 Members；现有 Help Request list/detail 链接跳转至新的
Community routes。

### 1.2 Alumni Directory

系统处理约 322 人的 alumni roster，完成 account matching、eligibility review、invitation
和 claim。Directory 展示 active + verified account、`publishStatus=published`、有效 publication
consent 且至少一个 verified affiliation 的 profile。

Alumni 可以编辑、预览、发布和撤回 profile，并分别启用 Career Advice、Warm Introduction
和 Formal Employee Referral。

Directory 支持按 name、company、industry、skills、general location、cohort 和 help offering
搜索与筛选。Card 位于 `Community → Alumni Directory`，格式为：

~~~text
Amy Chen
Product Manager · Microsoft
Seattle · EMBA 2022

愿意帮助：
✓ Career Advice
✓ Warm Introduction
✗ Formal Employee Referral

[Request Help]
~~~

Card 和 profile detail 使用已发布的职业资料、一般位置、verified affiliations 和三项
offering 状态。`Request Help` 显示该 alumni 当前启用的 offering。

### 1.3 Alumni Help

`CreateHelpRequestInput` 包含：

~~~text
alumniProfileId
requestedHelpType
openingNote?
consentVersion
disclaimerVersion
~~~

服务端从登录身份生成 `requesterId`。`requestedHelpType` 为 `career_advice`、
`warm_introduction` 或 `formal_employee_referral`。

| Action | Actor | Transition |
| --- | --- | --- |
| create | requester | new → requested |
| request information | provider | requested → needs_information |
| provide information | requester | needs_information → requested |
| propose alternative | provider | requested → alternative_proposed |
| confirm alternative | requester | alternative_proposed → accepted |
| reject alternative | requester | alternative_proposed → requested |
| accept | provider | requested → accepted |
| decline | provider | requested → declined |
| withdraw | requester | requested / needs_information / alternative_proposed → withdrawn |
| start | provider | accepted → in_progress |
| complete | provider | accepted / in_progress → completed |
| close | either participant | accepted / in_progress / completed → closed |

Alternative 必须是 provider 当前启用的 offering；requester 确认后成为 agreed help type。
系统在 create、alternative confirmation 和 accept 时校验 offering、consent 和 disclaimer。
Active request uniqueness key 为 `requesterId + alumniProfileId + requestedHelpType`。

进入 `accepted` 时，系统幂等创建成员为 requester 与 provider 的 Alumni Help Room。
双方在 Room 中自然确定具体背景、机会和行动。

Help Requests 页面显示 action 分组、requested/proposed/agreed help type、lifecycle timeline、
outcome timeline 和 Alumni Help Room 入口。

### 1.4 帮助结果

| Agreed help type | Outcome code | UI label |
| --- | --- | --- |
| career_advice | not_fulfilled | Career Advice 失约 |
| career_advice | completed | Career Advice 完成 |
| warm_introduction | not_fulfilled | Warm Introduction 失约 |
| warm_introduction | completed | Warm Introduction 完成 |
| formal_employee_referral | not_fulfilled | Formal Employee Referral 失约 |
| formal_employee_referral | interview_not_hired | Formal Employee Referral 获得面试但失败 |
| formal_employee_referral | hired_after_interview | Formal Employee Referral 面试通过最终被录取 |

结果流程：

1. 被帮助者提交 immutable outcome revision。
2. 服务端设置 UTC `dueAt = submittedAt + 480 hours`。
3. 帮助提供者在 `dueAt` 前选择 Confirm 或 Deny。
4. Worker 在 `dueAt` 幂等确认 pending revision，记录 `automatic_20_day`。
5. Deny 后，被帮助者提交新 revision，系统生成新的 480-hour window。
6. 每次 submit、resubmit、Confirm、Deny 和 automatic confirmation 写入 audit history。

曾进入 `accepted` 的 request 可在 retention 期内记录结果。Request、outcome 和 Room 保存各自
lifecycle。Detail UI 显示 revision、status、dueAt、available action 和
`confirmationMethod = provider | automatic_20_day`，并标记为参与者提交的结果。
Pending outcome deadline 在 Request completed/closed 或 Room archived 状态中继续执行。

### 1.5 Chat Rooms 与 Program Rooms

`Chat Rooms` 页面统一显示两类 Room：

- Alumni Help Room：由 accepted Help Request 创建；
- Program Room：每个 enabled Program 对应一个 primary Room。

页面分为 `Current` 与 `Past / Read-only`。每个 Room 提供 sequence-based history、text 和
safe-link message、Sending/Sent/Failed/Retry、read cursor、unread、mute/unmute、responsive
desktop/phone layout、REST cursor recovery 和 Socket.IO realtime update。

MongoDB 是 message source of truth；发送链路为 `persist → outbox → ack → scoped Socket emit`。
`clientMessageId` 保证 retry idempotency，`sequence` 用于 pagination、access window 和 unread。

`ProgramCommunitySettings` 保存 `enabled`、`opensAt`、`closesAt` 和 `archivedAt`。Open predicate
为 `enabled=true`、`opensAt <= now`、`closesAt=null | now<closesAt`、`archivedAt=null`。

Program Room membership 由 account status、active enrollment、effective completed-purchase
enrollment、Mentor、Class Representative 和 Mentee assignment 共同计算。多个 membership
sources 按 `userId` 合并；最后一个有效 source 结束时关闭 active access window。Program 页面提供
`Open Chat Room`。

- `mute/unmute` 更新该 Room 的 Push/Email preference，并保留内容与 unread；
- 最后一个有效 membership source 结束时记录 `visibleThroughSequence`，把 membership 转为
  `history_only`；
- history query 返回该 member 各 authorized access window 的 messages；
- `history_only` member 恢复资格时创建新的 access window；
- Program close 把 Room 转为 `archived`。

History 使用各 authorized window；send、unread、Socket subscription、announcement、Program
update 以及 Push/Email recipients 使用 current active window。

以下 current Program members 可以发布 Program announcement：

- Mentor；
- Class Representative；
- authorization level 为 Leader 或以上的 Mentee。

服务端在每次发布时重新计算 authorization 与 recipients。

### 1.6 数字提醒与通知

| 显示位置 | 数字定义 |
| --- | --- |
| 顶级 `Chat Rooms` 标签 | 所有 authorized active windows 的 chat unread 总数 |
| Chat Rooms 列表中的 Room row | 该 Room 的 unread 数 |
| `System Messages` 标签 | 未读 ERP system/workflow notifications 数 |
| `Help Requests` 标签 | 当前用户需要 action 的 unique request 数 |
| PWA launcher icon | `chatUnreadTotal + systemMessageUnread` |

Chat unread 计算 `sequence > lastReadSequence`、`senderId != currentUserId` 且 `kind` 为
`text | announcement` 的可见消息。Help action 包括回应 request/补充信息、确认或拒绝
alternative、Confirm/Deny outcome，以及 Deny 后 resubmit。

Room notification deep link 为 `/#/dashboard/chat-rooms/:conversationId`；Help 和 outcome
notification deep link 为 `/#/dashboard/community/help-requests/:requestId`。登录后恢复目标页。
Room mute 控制 Room text/announcement 的 Push 与 Email；Help/outcome delivery 使用用户的全局
channel preference。

| State change | Updated counter |
| --- | --- |
| Room read cursor advances | Chat unread |
| System Message marked read | System Message unread |
| Help workflow action completed | Help action required |

### 1.7 网站、PWA 与 Email

同一 React codebase 交付 desktop browser、phone browser 和 installable PWA：

- Web App Manifest、production icons 和 standalone launch；
- versioned Service Worker、app shell、offline page 和 update prompt；
- private API 使用 `Cache-Control: no-store` 和 network fetch strategy；
- Android/browser install UX；
- iOS/iPadOS 16.4+ Home Screen install 与 Push UX；
- user-initiated notification permission、per-installation PushSubscription 和 VAPID；
- notification preferences、authorized deep links 和 Email fallback；
- iPhone、iPad、Android 和 desktop browser qualification。

Email fallback 根据 user email preference、active PushSubscription 状态和 permanent endpoint
failure 生成 outbox delivery。

### 1.8 Registration、数据与 API

| Registration / KPI field | Contract |
| --- | --- |
| phone | 完整 profile/publish 时 required；private |
| birthYear | 出生年份 |
| residenceCity | structured city |
| residenceRegion | structured state/province/region |
| residenceCountryCode | standard country code |
| employmentStatus | structured employment state |
| company | employed/self-employed 时 required |
| occupation | optional |

现有账号通过 profile-completion grace period 补充字段。`User` 保存 canonical employment/KPI
data；`AlumniProfile.searchProjection` 是 derived、rebuildable search data。

| API | Page-specific response |
| --- | --- |
| `/api/directory` | `DirectoryCardDTO` / `DirectoryDetailDTO` / `OwnAlumniProfileDTO` |
| `/api/community/members` | `CommunityMemberDTO` |
| `/api/admin/users` | `AdminUserDTO` + existing account-management permission |
| `/api/alumni-help-requests` | `AlumniHelpRequestDTO` / `AlumniHelpOutcomeDTO` |
| `/api/conversations` | `ConversationDTO` / `ChatMessageDTO` / `chatUnreadTotal` |
| `/api/programs/:programId/community-settings` | `ProgramCommunitySettingsDTO` |
| `/api/push/subscriptions` | `PushSubscriptionDTO` |

Directory DTO 提供 published profile、general location、verified affiliation 和 help offering
字段；CommunityMemberDTO 提供 member display data；AdminUserDTO 提供现有账号管理字段与操作。
所有 serializer 使用明确字段表，并按 resource 在 HTTP、Socket 和 worker 层执行 authorization。
现有 `/api/users` 和 search consumers 迁移到对应的 page-specific API；compatibility access
使用 account-management permission 和 `AdminUserDTO`，并由 authorization/PII regression 覆盖。

数据层新增 `AlumniProfile`、`AlumniAffiliation`、`AlumniInvitation`、`AlumniImportBatch`、
`ConsentRecord`、`AlumniHelpRequest`、`AlumniHelpOutcomeSubmission`、`Conversation`、
`ConversationMember`、`ChatMessage`、`ProgramCommunitySettings`、`PushSubscription`、
`NotificationPreference` 和 `NotificationOutbox`，并实现唯一索引、audit、retention、
transaction/CAS、idempotency、outbox retry/reconciliation 和 migration。

## 2. 实施清单

### M0 — Foundation

- [x] M0-01 建立 API permissions、page-specific DTO serializers、runtime schemas，并迁移现有 `/api/users` consumers。
- [x] ADD-001 建立权限受控的 `UserPickerDTO` API，由服务端按 `userId` 解析业务资料，并让 Analytics 使用聚合 DTO。
  - 验证：backend unit 5,694、HTTP 319、targeted integration 53、frontend 1,892；lint、type-check、production build 与 deployment guards 通过。
- [x] M0-02 建立 HTTP、Socket、worker authorization 与 AuditLog。
  - 验证：backend unit 5,830、HTTP 321、MongoDB integration 1,708、frontend 1,901；lint、type-check、production build、deployment guards 与独立审查通过。
- [x] M0-03 建立 transaction/CAS/idempotency、durable outbox 和 reconciliation。
  - 验证：backend unit 5,958、HTTP 321、MongoDB integration 1,718、frontend 1,901；lint、type-check、production build、deployment guards 与独立审查通过。
- [x] ADD-002 修复 System/Bell Message 收件人授权、Socket payload 隔离与 Trio 实时消息单次投递。
  - 验证：backend unit 5,996、HTTP 329、MongoDB integration 1,726、frontend 1,901；lint、type-check、production build、deployment guards 与独立审查通过。
- [x] ADD-003 统一保护 System Message 发布、手动通知邮件与消息 cleanup 管理入口，要求 `MANAGE_NOTIFICATIONS` 权限；System Messages 创建入口同步仅向 Administrator 与 Super Admin 显示。
  - 验证：backend unit 5,996、HTTP 379、MongoDB integration 1,733、frontend 1,906；lint、type-check、production build、deployment guards 与独立审查通过。
- [x] M0-04 建立 versioned migration runner、dry-run、resume 和 rollback。
  - 验证：backend unit 6,338、HTTP 379、MongoDB integration 1,759、frontend 1,906；migration unit 342、真实事务 26；lint、type-check、production build、checksum/CLI smoke 与独立审查通过。
- [x] M0-05 建立 production full-stack E2E、Alumni Network 部署/运行模式控制、readiness、recovery controls 和 monitoring。
  - 验证：backend unit 6,422、HTTP 398、targeted MongoDB integration 21、frontend 1,923、production full-stack E2E；lint、type-check、production build、deployment guards 与独立审查通过。
- [x] M0-06 登记 Travis 于 2026-09-10 批准的 retention、field normalization、capacity、RPO/RTO 和 Program mapping 参数。
  - 参数：[Alumni Network 已批准参数](ALUMNI_NETWORK_APPROVED_PARAMETERS.md)。
  - 验证：批准参数一致性、Markdown 本地链接、diff check、deployment guardrails 与独立审查通过。

### M1 — Registration / KPI

- [x] M1-01 实现 1.8 registration fields、validators 和 shared types。
  - 验证：backend unit 6,448、HTTP 398、targeted MongoDB auth integration 22、frontend 1,923；ISO dataset generation check、shared CJS/ESM package、lint、type-check、production build、deployment guards 与独立审查通过。
- [x] M1-02 更新 signup、profile、publish gate 和 authorized admin edit UI/API。
  - 验证：backend unit 6,454、HTTP 398、targeted MongoDB integration 83、frontend 1,945；ISO dataset generation check、lint、type-check、production build、deployment guards 与独立审查通过。
- [x] M1-03 实现 existing-user completion、user-confirmed backfill、baseline migration 和 rollback。
  - 验证：backend unit 6,454、HTTP 398、MongoDB integration 全量 1,784/1,785 与并行 setup 偶发项 standalone 7/7、M1-03 migration 3/3、frontend 1,955；checksum、lint、type-check、production build、deployment guards 与独立审查通过。
- [x] M1-04 实现 privacy-safe KPI analytics/export 及 tests。
  - 验证：backend unit 6,478、HTTP 401、MongoDB integration 1,786、frontend 1,968；lint、type-check、production build、deployment guards 与独立审查通过。

### M2 — Community 与 Directory

- [x] M2-01 实现 alumni profile、affiliation、invitation、import 和 consent models/indexes。
  - 验证：backend unit 6,514、HTTP 401、MongoDB integration 1,799、frontend 1,968；lint、type-check、production build、deployment guards 与独立审查通过。
- [x] M2-02 实现 roster CSV dry-run、matching、review、invitation、claim 和 rerun。
  - 验证：backend unit 6,602、HTTP 412、MongoDB integration 1,831、frontend 1,968；lint、type-check、production build、production full-stack E2E、deployment guards 与独立审查通过。
- [x] M2-03 实现 profile edit、preview、consent、publish、withdraw 和 offering settings。
  - 验证：profile targeted backend unit 10、HTTP 5、MongoDB integration 7、frontend 33 全部通过。
- [x] M2-04 实现 Community navigation、routes、redirects、Members 和 User Management entry。
  - 验证：navigation、route、permission 与 DTO targeted frontend 40 全部通过。
- [x] M2-05 实现 Directory API/UI、card/detail、search/filter 和 pagination。
  - 验证：Directory targeted backend unit 6、HTTP 4、MongoDB integration 10、frontend 21；500-profile p95 gate 通过。
- [x] M2-06 完成 import、permission、DTO、search、responsive 和 performance tests。
  - 验证：backend unit 6,621、HTTP 421、MongoDB integration 1,848、frontend 2,044；lint、type-check、production build、deployment guards、production full-stack E2E 与独立审查通过。

### M3 — Alumni Help 与 outcomes

- [x] M3-01 实现 Help Request schema、uniqueness、actor permissions 和 transitions。
- [x] M3-02 实现 Request Help、information exchange、alternative 和 list/detail UI。
- [x] M3-03 实现 accepted request 的 Alumni Help Room provisioning。
- [x] M3-04 实现七种 outcome、immutable revisions、Confirm/Deny 和 audit history。
- [x] M3-05 实现 480-hour worker、automatic confirmation、resubmission 和 recovery。
- [x] M3-06 实现 workflow notifications、deep links 和 `helpActionRequiredCount`。
- [x] M3-07 完成 lifecycle、race、deadline、permission、notification 和 counter tests。
  - 验证：backend unit 6,664、HTTP 429、MongoDB integration 1,852/1,854 与并行隔离偶发项 standalone 23/23、frontend 2,069；M3 MongoDB transaction 6、production full-stack E2E、lint、type-check、production build、deployment guards 与独立审查通过。

### M4 — Chat Rooms

- [x] M4-01 实现 conversation、member、message、sequence 和 access-window models/indexes。
- [x] M4-02 实现 Room list/detail/history/send/read/mute APIs。
- [x] M4-03 实现 persist/outbox/ack/Socket pipeline、retry 和 REST recovery。
- [x] M4-04 实现 per-room unread、`chatUnreadTotal` 和 counter reconciliation。
- [x] M4-05 实现 Chat Rooms navigation、对话泡泡 icon 和 responsive UI。
- [x] M4-06 完成 sanitization、rate limit、retention、two-client、reconnect、ACL 和 load tests。
  - 验证：backend unit 6,714、HTTP 442、MongoDB integration full 1,874/1,875（并行隔离偶发项 standalone 13/13）、frontend 2,124；真实 two-client transport/reconnect/ACL、approved capacity load、production full-stack E2E、lint、type-check、production build、deployment guards 与独立审查通过。

### M5 — PWA 与 notifications

- [x] M5-01 实现 manifest、icons、Service Worker、offline 和 update flow。
- [x] M5-02 实现 Android/browser 与 iOS/iPadOS Home Screen install UX。
- [x] M5-03 实现 PushSubscription、VAPID、preferences 和 Room mute routing。
- [x] M5-04 实现 event routing、badges、deep links、login recovery 和 Email fallback。
- [x] M5-05 完成 web security headers、secret operations 和 browser/device-profile tests。
  - 验证：backend unit 6,764、HTTP 445、MongoDB integration 1,882/1,883 与并行隔离项 standalone 3/3、frontend 2,205；standard E2E 3/3、PWA browser/device-profile matrix 16/16、production full-stack E2E 1/1；lint、type-check、production build、deployment guards 与独立审查通过。

### M6 — Program Rooms

- [x] M6-01 实现 ProgramCommunitySettings 与 primary Room provisioning。
- [x] M6-02 实现 enrollment/assignment membership resolver、event sync 和 reconciliation。
- [x] M6-03 实现 mute、unenroll cutoff、history_only、re-enroll window 和 archive。
- [x] M6-04 实现 Program deep link 与 Current/Past Room UI。
- [x] M6-05 实现 announcement authorization、unread 和 notification routing。
- [x] M6-06 完成 membership、announcement、cutoff、re-enroll、archive 和 load tests。
  - 验证：backend unit 6,943、HTTP 454、MongoDB integration 1,923/1,924（并行隔离项 standalone 29/29）、frontend 2,242；approved capacity 18/18，production full-stack E2E、lint、type-check、migration checksum、production/PWA build、deployment guards 与独立审查通过。

### G1 — Production release

- [ ] G1-01 完成 privacy/consent content、security review 和 WCAG 2.2 AA review。
- [ ] G1-02 完成 production migration（含 affiliation canonical identity index replacement）、alumni import dry-run 和 data verification。
- [ ] G1-03 完成 backup/restore、rollback、outbox/deadline/membership/Service Worker recovery。
- [ ] G1-04 完成 expected-capacity load、full regression 和 real-device qualification。
- [ ] G1-05 完成 monitoring、alerts、runbook、support preparation 和 release defect correction。
- [ ] G1-06 在一次 production release 中开启 M0–M6，并执行 smoke verification。

### M7 — 上线后改进

- [ ] M7-01 根据 production monitoring 与用户反馈修复已批准功能，并补充 regression evidence。
- [ ] M7-02 持续记录任务状态、验证结果和下一项工作。
