# @Cloud Alumni Network 已批准参数

- 版本：1.0
- 批准日期：2026-09-10
- 批准人：Travis Fan，Assistant Director of IT and Website
- 适用范围：M1–M6 与 G1

对应的 M1–M6 tasks 实现这些参数，G1 完成 production migration 和 release qualification。

## 1. Field normalization

| Field | Contract |
| --- | --- |
| `phone` | Required、private；使用 country selector 解析并保存为 E.164；格式为 `^\+[1-9]\d{7,14}$` |
| `birthYear` | Required、private BSON integer；范围为 `1900` 至当前 UTC year |
| `residenceCountryCode` | Required；ISO 3166-1 alpha-2 uppercase |
| `residenceRegion` | US required，其他国家 optional；UI 显示名称，保存对应 ISO 3166-2 code |
| `residenceCity` | Required；Unicode NFC、trim、合并连续空格、单行；1–100 characters |
| `employmentStatus` | Required enum：`employed`、`self_employed`、`student`、`not_currently_employed`、`retired` |
| `company` | `employed` / `self_employed` 时 required；其他状态保存 `null`；1–100 characters |
| `occupation` | Optional；有值时使用 display-text normalization；1–100 characters |
| Display text | Unicode NFC、trim、合并连续空格、单行，保留显示大小写和音标 |
| Search projection | NFKD、移除 combining marks、locale-neutral lowercase、标准化标点和空格 |
| Legacy `homeAddress` | 用户确认 structured residence 后清除 |

本人及拥有现有 User Management permission 的用户可以读取 exact private fields。Directory DTO
不返回 `phone` 或 `birthYear`。Birth-year KPI 使用十年区间；任何可筛选结果少于 5 人时不返回。
Required contracts 用于新注册；现有账号通过 profile-completion grace flow 补齐，并在 Alumni
Profile publish 前满足 required fields。

## 2. Retention

月份使用 UTC calendar month；`30 days` 与 `480 hours` 使用固定时长。

| Data | Retention contract |
| --- | --- |
| User KPI/PII、AlumniProfile、AlumniAffiliation | Account deletion 获准后立即停止公开展示，30 天内从 primary database 删除 |
| Withdrawn AlumniProfile | 立即停止公开展示；账号存在期间保留为 private draft |
| AlumniImportBatch raw rows / row errors | Batch terminal 后 30 天 |
| AlumniImportBatch counts / checksum / status | Batch terminal 后 6 个月 |
| 未 claim 的 roster / invitation contact | `lastInvitationSentAt` 后 6 个月 |
| Invitation secret | `expiresAt = issuedAt + 14 days`；claim 或 reissue 立即使现有 secret 失效 |
| ConsentRecord | Superseded、withdrawn 或 account deletion 后 12 个月 |
| 从未 accepted 的 Help Request | Declined 或 withdrawn 后 2 个月 |
| 曾 accepted 的 Help Request、outcome revisions、timeline | `purgeAt = max(closedAt + 12个月, latestOutcomeDueAt + 30天)` |
| ChatMessage | `createdAt + 12个月` |
| Conversation、ConversationMember、access windows | `purgeAt = max(archivedAt + 12个月, latestChatMessage.purgeAt + 30天)` |
| PushSubscription | Unsubscribe 或 endpoint permanent failure 后立即删除；连续 90 天未成功使用时删除 |
| NotificationOutbox | Delivered 后 30 天；dead 后 90 天；pending / processing 保留至 terminal |
| AuditLog | 12 个 UTC calendar months；fallback TTL 为 367 天 |
| De-identified KPI aggregates | 无自动到期；任何可筛选结果少于 5 人时不返回 |

Flex 保留最近 8 个 daily snapshots。Primary database 已删除的数据随对应 snapshots 到期，恢复流程在
开放生产读写前执行当前 retention cleanup 和 account-deletion reconciliation。
曾 accepted 的 Help Request 在记录 immutable `closedAt` 后开始 retention clock。

## 3. Capacity 与边界

### Qualification baseline

这些数值是 load-test inputs；Program Room membership 仍按 eligibility resolver 的结果完整建立。

| Parameter | Approved value |
| --- | --- |
| Dataset | 2,000 ERP users、500 published alumni profiles、500 Programs，其中 50 个同时 open |
| Messaging data | 5,000 Conversations、1,000,000 retained ChatMessages |
| Program Room | 500 active members |
| Alumni Help Room | Exactly 2 members |
| Realtime clients | 250 simultaneous users、500 Socket.IO connections |
| Message load | 20 persisted messages/second，持续 5 分钟 |
| Announcement fan-out | 500 recipients；outbox batch size 100 |
| API performance | Directory、Room list 和 history p95 ≤ 1,000 ms |
| Message performance | Persist-to-ack p95 ≤ 1,500 ms；p99 ≤ 3,000 ms |
| Reliability | 5xx/timeout < 1%；unauthorized delivery、duplicate persistence 和 reconnect message loss 均为 0 |

### Request boundaries

| Parameter | Approved value |
| --- | --- |
| Message / announcement text | ≤ 4,000 Unicode code points；完整 HTTP/Socket payload ≤ 16 KiB |
| Safe URL | ≤ 2,048 characters |
| Message history page | Default 50；maximum 100 |
| Room list page | Default 30；maximum 100 |
| Directory page | Default 24；maximum 100 |
| Send rate per user + Room | 20/minute；burst 5/10 seconds |
| Send rate per account | 60/minute |
| Program announcement rate | 每个 Program 10/hour |
| Socket.IO connections per account | Maximum 5；达到上限时关闭最旧连接 |
| Unread badge | `0–99`，随后显示 `99+` |
| Production MongoDB pool | `maxPoolSize=10` |

### Flex operating gates

| Gate | Approved value |
| --- | --- |
| Launch storage | `dataSize + indexSize ≤ 3.5 GB` |
| Storage tier trigger | `dataSize + indexSize ≥ 4 GB`，或预计 90 天内达到 5 GB |
| Performance tier trigger | 持续接近 `400 ops/s`，或未达到批准的 p95 targets |
| Recovery tier trigger | Restore drill 超过 RTO，或需要 point-in-time recovery |

## 4. Program mapping

1. `Program._id` 一对一关联一个 primary Program Room；Program display data 更新时保留 Room ID。
2. Current access 要求 `User.isActive=true`、`User.isVerified=true`，且 Program Room 满足 open predicate。
3. Membership sources 按 `userId` 合并：

   - `Program.mentors[].userId` → Mentor；
   - `Program.adminEnrollments.classReps[]` → Class Representative；
   - `Program.adminEnrollments.mentees[]` → Mentee；
   - `purchaseType=program`、matching `programId`、`status=completed` 且没有 `unenrolledAt` 的
     Purchase → explicit student-role mapping。
4. `ProgramCommunitySettings.studentRoleMappings` 保存每个
   `studentRoleId → mentee | class_representative`。Migration 根据现有 role data 生成 candidate；
   现有 Program 在启用 Room 前确认 candidate。
5. 多个 membership sources 的权限取并集，显示优先级为
   `Mentor > Class Representative > Mentee`；最后一个有效 source 结束时关闭 active access window。
6. `opensAt` 与 `closesAt` 保存明确 UTC instant；Program management UI 保存这些设置。
7. 首次取得资格时设置 `visibleFromSequence = current lastSequence + 1`。
8. Unenroll 关闭相应 enrollment entitlement；最后一个有效 source 因此结束时，在 current
   sequence 关闭 window。`history_only` member 恢复资格时保留旧 window，并从
   `current lastSequence + 1` 新建 window。
9. Account deactivation 或 unverification 关闭 active windows；恢复资格后新建 window。
10. Program archive 在 current sequence 关闭 active windows，并按 retention 提供 Past / Read-only history。
11. Announcement authorization 在每次发布时重新计算：Mentor、Class Representative，以及
    authorization level 为 Leader 或以上的 Mentee。

## 5. Flex recovery 与成本

| Parameter | Approved value |
| --- | --- |
| Production Atlas tier | Flex |
| Database RPO target | ≤ 24 hours |
| Database RTO target | ≤ 8 hours；以 restore drill 验证 |
| Restore window | Atlas 最近 8 个 daily snapshots |
| Snapshot review | Monthly |
| Isolated full restore drill | Production release 前一次，此后 quarterly |
| Transaction qualification | 在真实 Flex 上验证 transaction、migration、idempotency、outbox 和 AuditLog |
| Restore qualification | 验证 collections、indexes、TTL、counts/checksum、Chat、Help outcome 和 access windows |
| External effects during restore | Email、Push、Socket emit 和 workers disabled |
| Uploaded assets | Release qualification 验证 Render `/uploads` persistence 和 backup |
| Core monthly planning cost | Render Static Site `$0` + backend `$7` + Atlas Flex `$8–$30` = `$15–$37`，另计其他实际服务 |

RPO 表示恢复后最多丢失的已确认生产数据时间；RTO 从检测或确认数据事故开始，到完成完整性验证并
重新开放生产读写为止。

参考：[Atlas Flex costs](https://www.mongodb.com/docs/atlas/billing/atlas-flex-costs/)、
[Atlas Flex limits](https://www.mongodb.com/docs/atlas/reference/flex-limitations/)、
[Atlas Flex backups](https://www.mongodb.com/docs/atlas/backup/cloud-backup/flex-cluster-backup/)、
[Render pricing](https://render.com/pricing)。
