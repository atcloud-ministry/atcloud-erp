# Audit Log Retention Policy

## Approved implementation contract

| Parameter | Value |
| --- | --- |
| Primary retention | 12 UTC calendar months |
| Cleanup schedule | Hourly |
| MongoDB TTL fallback | 367 elapsed days |
| Release configuration | `AUDIT_LOG_RETENTION_MONTHS=12` and `AUDIT_LOG_TTL_FALLBACK_DAYS=367` |

This contract is part of the
[Alumni Network approved parameters](ALUMNI_NETWORK_APPROVED_PARAMETERS.md).

## Release enforcement requirements

1. Application cleanup must calculate the cutoff with UTC calendar-month arithmetic and month-end
   clamping, then delete records older than the cutoff.
2. The TTL fallback must expire records 367 elapsed days after `createdAt`.
3. A versioned migration must update and verify the existing production TTL index before release.
4. Cleanup must report success, deletion count, and failure without recording audit payloads.
5. Audit-log APIs must retain their existing authorization and return bounded, purpose-specific DTOs.

Help Request and outcome timelines persist as independent business records under their approved
retention contract.

## Flex restore

An isolated Atlas Flex restore keeps Email, Push, Socket emit, and workers disabled while it:

1. removes records whose approved retention has expired;
2. reconciles account deletions;
3. verifies the AuditLog TTL index and cutoff behavior; and
4. completes application integrity checks before production read/write access opens.

Deleted live records can remain in Atlas Flex's eight retained daily snapshots until those snapshots
expire.

## Release verification requirements

- Unit tests must cover UTC month-end and leap-year boundaries.
- MongoDB integration tests must cover scheduled cleanup and TTL index configuration.
- Migration verification must read the actual production index definition.
- The pre-release restore drill must verify cleanup before external effects and production access
  are enabled.
