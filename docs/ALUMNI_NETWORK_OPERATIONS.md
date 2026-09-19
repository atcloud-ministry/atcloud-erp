# Alumni Network 运行说明

## 1. 功能控制

`ALUMNI_NETWORK_RELEASE_AVAILABLE` 是部署上限，`render.yaml` 默认值为 `false`；仅为 `true`
时 MongoDB `feature_controls` 单例文档中的 stored mode 生效，否则 effective mode 为 `off`。

| Mode | Read | Write |
| --- | --- | --- |
| `off` | 关闭 | 关闭 |
| `read_only` | 开启 | 关闭 |
| `on` | 开启 | 开启 |

- `GET /api/runtime-config`：公开、`no-store`、固定 versioned DTO；读取失败时返回 `off`。
- `GET /api/system/feature-controls`：读取当前控制状态。
- `PATCH /api/system/feature-controls/alumni-network`：提交 `mode` 与 `expectedRevision`。
- 上述两个 feature-control 管理接口要求 `MANAGE_SYSTEM_SETTINGS`；更新使用 CAS、MongoDB transaction 和 AuditLog。
- React `RuntimeConfigProvider` 严格校验 DTO，并向后续页面提供 read/write capability。
- 后端新功能分别使用 `requireAlumniNetworkReadable` 和 `requireAlumniNetworkWritable`。

## 2. 探针

- `GET /api/readiness`：检查 MongoDB ping 与 reliability foundation，返回 `200` 或 `503`。
- `GET /api/readiness/live`：进程存活探针，返回 `200`。
- Render health check 使用 `/api/readiness`。
- Deployment guard 校验单实例、`/api/readiness` health check 与关键 production env。
- readiness 查询按 2 秒窗口合并和缓存；单次探测期限为 2 秒。
- feature-control 状态独立记录；读取异常时 Alumni Network runtime mode 为 `off`。

## 3. Recovery control

- `GET /api/system/recovery`：返回 NotificationOutbox backlog 和可恢复数量。
- `POST /api/system/recovery/notification-outbox/reconcile`：恢复过期 lease，并把已耗尽尝试次数的记录转为 dead letter。
- 两个接口要求 `MANAGE_SYSTEM_SETTINGS`。
- POST 要求 `Idempotency-Key`；`limit` 默认 `25`，范围为 `1–25`。
- outbox 更新、幂等 receipt 与 AuditLog 在同一 MongoDB transaction 中提交。
- `RECOVERY_COMMIT_UNCERTAIN` 要求使用原 `Idempotency-Key` 重试。
- 状态查询期限为 1.5 秒，HTTP 响应期限为 15 秒，单次数据库更新期限为 1 秒；同一时间只运行一项手动恢复，有效 lease 不进入可恢复数量。

## 4. Monitoring

`GET /metrics` 以固定 label 输出：

- `atcloud_application_readiness`
- `atcloud_alumni_network_mode`
- `atcloud_notification_outbox_backlog`
- `atcloud_notification_outbox_recoverable`
- `atcloud_notification_outbox_snapshot_collection_success`
- `atcloud_recovery_operations_total`

Recovery gauges 按 30 秒窗口合并和缓存，单次采集期限为 2 秒。响应使用 `no-store`。

## 5. 验证

~~~bash
npm run test:e2e:fullstack
~~~

该命令使用 loopback MongoDB replica set、production frontend build、built Express server、真实 JWT、
浏览器 CORS 请求与 `off → read_only → on → off` 控制链路。CI 的 `fullstack-e2e` job 执行同一命令。

## 6. Alumni roster production qualification

执行窗口内保持 Alumni Network mode 为 `off`。先使用同一 release artifact 执行 migration，
再部署 backend 并等待 readiness healthy；涉及 roster 数据的写操作随后执行。CSV 放在受限的
临时路径；MongoDB URI 仅通过 `MONGODB_URI` 环境变量提供。`--operator` 使用 release/operator
code，不填写姓名或邮箱。

1. 构建 production CLI，并确认 migration ledger 与计划：

~~~bash
cd backend
npm run build
npm run -s migration -- status --json
npm run -s migration -- dry-run --json
~~~

2. 执行 migration 后再次取得 healthy status。写命令使用实际 database name、operator 和完整确认参数：

~~~bash
npm run -s migration -- apply --confirm-db DATABASE --operator RELEASE_CODE --execute --yes --json
npm run -s migration -- status --json
~~~

部署同一 release artifact 的 backend，确认 `/api/readiness` healthy，并保持 Alumni Network mode
为 `off`。

3. 检查批准的 CSV。将输出的 exact-byte SHA-256、`totalRows` 和规范化 email 去重后的
`uniqueContacts` 与数据负责人批准的 source manifest 对照：

~~~bash
npm run -s alumni-import -- inspect --file /restricted/alumni.csv --json
~~~

4. 使用批准值执行 dry-run；保存返回的 `batch.id`。`--idempotency-key` 使用本次操作固定 UUID，
重试时沿用同一个值：

~~~bash
npm run -s alumni-import -- dry-run --file /restricted/alumni.csv \
  --expected-sha256 SHA256 --expected-row-count ROWS \
  --expected-unique-contacts CONTACTS --actor-id ACTOR_OBJECT_ID \
  --idempotency-key UUID --confirm-db DATABASE --operator RELEASE_CODE \
  --execute --yes --json
~~~

5. 立即验证 batch、Program mapping、当前 account matching、row errors/counts，以及所有现存
alumni affiliation identity。报告只包含 versioned aggregate counts：

~~~bash
npm run -s alumni-import -- verify --file /restricted/alumni.csv \
  --batch-id BATCH_OBJECT_ID --expected-sha256 SHA256 \
  --expected-row-count ROWS --expected-unique-contacts CONTACTS \
  --actor-id ACTOR_OBJECT_ID --confirm-db DATABASE --json
~~~

6. verification 通过后，记录 batch ID、revision、负责人和计划处理时间。用于后续 review/apply 的
production batch 保留至 release window；仅用于 qualification 的 batch 立即以
`operator_request` 取消。verification 为 `failed` 时，以 `data_validation_failed` 取消后再修正
source 或 production data。取消时使用报告中的 batch revision 和相同 source expectations：

~~~bash
npm run -s alumni-import -- cancel --batch-id BATCH_OBJECT_ID \
  --expected-revision REVISION --expected-sha256 SHA256 \
  --expected-row-count ROWS --expected-unique-contacts CONTACTS \
  --reason-code REASON_CODE --actor-id ACTOR_OBJECT_ID \
  --idempotency-key UUID --confirm-db DATABASE --operator RELEASE_CODE \
  --execute --yes --json
~~~

Exit code `0` 表示通过，`2` 表示 CLI 参数错误，`3` 表示 expectation、authorization、readiness、
index 或 verification gate 未通过。保存 aggregate JSON、migration status 和 AuditLog evidence；完成后删除临时 CSV。

## 7. Isolated restore qualification and recovery

G1-03 使用 `recovery-qualification` 检查恢复副本，并使用 `recovery-reconcile`
执行有界恢复批次。报告仅包含 collection counts、SHA-256 structural digests 和 aggregate
recovery counts。

1. 从同一 immutable Atlas snapshot 创建两个隔离的 restore database：一个 baseline，一个
   recovery target。记录 snapshot ID、时间和两个 database name。
2. 在 baseline 运行相同 release artifact，生成结构化 baseline manifest。使用仅授权该
   restore database 的 Atlas credential，并使 URI 中的 database name 与
   `RESTORE_ISOLATION_DATABASE` 完全一致：

~~~bash
export RESTORE_ISOLATION_MODE=true
export RESTORE_ISOLATION_DATABASE='atcloud-restore-baseline-YYYYMMDD'
export NOTIFICATION_OUTBOX_ENABLED=false
export SCHEDULER_ENABLED=false
export WEB_PUSH_ENABLED=false
export ALUMNI_NETWORK_RELEASE_AVAILABLE=false
export MONGODB_URI='RESTORED_BASELINE_DATABASE_URI_FROM_SECURE_STORE'

cd backend
npm run build
npm run -s recovery-qualification -- inspect \
  --confirm-db "$RESTORE_ISOLATION_DATABASE" --json \
  > /restricted/restore-baseline-manifest.json
~~~

3. 将相同 isolation variables 配置到 recovery target；更新
   `RESTORE_ISOLATION_DATABASE` 和 `MONGODB_URI` 后，用 baseline manifest 验证该副本：

~~~bash
export RESTORE_ISOLATION_DATABASE='atcloud-restore-recovery-YYYYMMDD'
export MONGODB_URI='RESTORED_RECOVERY_DATABASE_URI_FROM_SECURE_STORE'

npm run -s recovery-qualification -- verify \
  --confirm-db "$RESTORE_ISOLATION_DATABASE" \
  --manifest /restricted/restore-baseline-manifest.json --json
~~~

4. 准备受限的 account-deletion delta。它只包含 snapshot 创建后已删除的账号，保留源
   `deletedAt`，并由 source AuditLog `alumni_account.deleted` 记录核对。没有条目时仍使用
   空数组：

~~~json
{
  "schemaVersion": 1,
  "kind": "alumni_account_deletion_reconciliation",
  "sourceSnapshotAt": "2026-09-19T00:00:00.000Z",
  "entries": []
}
~~~

5. 使用新的 UUID 执行一轮恢复。`incomplete` 时用新的 UUID 继续；transaction outcome
   不确定时使用相同 UUID 重试。每个 manifest 的 Program membership checkpoint 会跨轮保存，
   成功后保留 terminal checkpoint；并发轮次以 compare-and-set gate 停止并重新开始。

~~~bash
npm run -s recovery-reconcile -- execute --confirm-db "$RESTORE_ISOLATION_DATABASE" \
  --operator RELEASE_CODE --idempotency-key UUID \
  --account-deletion-manifest /restricted/account-deletions.json \
  --execute --yes --json
~~~

每轮最多处理 100 个 account deletions、每类 retention 500 条、100 个 Program membership、
500 个 audit logs、500 个 TTL records、500 个 outcome deadlines 和 100 个 outbox records。
account-deletion delta 尚有记录时，先完成该 delta，再运行其余恢复项。

6. 在恢复报告为 `completed` 后，对副本运行最终检查，并保存 aggregate JSON：

~~~bash
npm run -s recovery-qualification -- inspect \
  --confirm-db "$RESTORE_ISOLATION_DATABASE" --json \
  > /restricted/restore-recovery-final.json
~~~

`0` 表示完成，`2` 表示参数或 manifest 无效，`3` 表示 isolation、integrity、comparison 或
recovery gate 未通过。Migration rollback 使用 [Database migrations](DATABASE_MIGRATIONS.md) 的
rollback procedure，并记录 migration ledger evidence。
