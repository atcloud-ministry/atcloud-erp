# Alumni Network M0-05 运行说明

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
