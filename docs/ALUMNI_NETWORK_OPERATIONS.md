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
