# @Cloud Alumni Network 已批准参数

- 版本：1.2
- 批准日期：2026-09-10；Atlas Free 发布方案及自助 Alumni Profile／电话体验修正由 Travis 于 2026-09-21 批准
- 批准人：Travis Fan，Assistant Director of IT and Website
- 适用范围：M1–M6 与 G1

对应的 M1–M6 tasks 实现这些参数，G1 完成 production migration 和 release qualification。

## 1. Field normalization

| Field | Contract |
| --- | --- |
| `phone` | Required、private；按所选国家解析有效号码，保存为国际格式；美国号码 `5102581542` 保存为 `+15102581542`；新注册默认美国且可更改 |
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
Required contracts 用于新注册；现有账号通过 profile-completion flow 补齐。注册和补全时
幂等建立私密 Alumni Profile 草稿；已补全的账号执行补建。资料公开须由本人另行同意。

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
| Conversation、ConversationMember、access windows | `purgeAt = max(archivedAt + 24个月, latestChatMessage.purgeAt + 30天)` |
| PushSubscription | Unsubscribe 或 endpoint permanent failure 后立即删除；连续 90 天未成功使用时删除 |
| NotificationOutbox | Delivered 后 30 天；dead 后 90 天；pending / processing 保留至 terminal |
| AuditLog | 12 个 UTC calendar months；fallback TTL 为 365 天 |
| De-identified KPI aggregates | 无自动到期；任何可筛选结果少于 5 人时不返回 |

曾 accepted 的 Help Request 在记录 immutable `closedAt` 后开始 retention clock。

## 3. Capacity 与边界

### 工程负载测试基线

这些数值用于隔离的本机 MongoDB 负载回归，不代表 Atlas Free 的生产容量承诺；Program Room
membership 仍按 eligibility resolver 的结果完整建立。

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

### Atlas Free 发布与运行门槛

| Gate | Approved value |
| --- | --- |
| Launch storage | 同一 Free 集群全部 database 的 data + indexes ≤ 256 MB |
| Storage review | 达到 256 MB，或预计 90 天内达到 384 MB 时评估升级 |
| Throughput review | 持续达到 50 database ops/s，或未达到批准的 p95 targets 时评估升级 |
| Transfer review | 任一方向连续 7 天达到 5 GB 时评估升级 |
| Connection review | 达到 250 Atlas connections 时评估升级 |
| Runtime qualification | 在现有 Free staging database 验证 transaction、migration、idempotency、outbox、AuditLog、TTL 与真实双账号流程；负载测试只在隔离本机数据库执行 |

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

## 5. Atlas Free 与发布风险

| Parameter | Approved value |
| --- | --- |
| Production Atlas tier | Free，沿用当前集群；staging 与 production 使用不同 database |
| Release qualification | 验证现有生产库 migration、索引/TTL、账号草稿补建与数据一致性，以及上线 smoke |
| Uploaded assets | 验证 Render `/uploads` 在正常部署后仍可访问 |
| Atlas monthly cost | `$0`；Render 与其他服务按实际用量另计 |

新增付费资源、套餐升级，以及增加定时 CI 或自动部署等持续用量，须经 Travis 事先批准。

Travis 接受 Atlas Free 无自动备份、无异地备份及恢复保障的发布风险；数据库故障或误操作可能造成
无法恢复的生产数据丢失，数据丢失概率与恢复时间均无保证。此项风险接受不改变个人资料保护、权限、
账号删除和主库 retention 要求。

参考：[Atlas Free limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/)、
[Render pricing](https://render.com/pricing)。
