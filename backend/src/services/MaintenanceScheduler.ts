import { createLogger } from "./LoggerService";
const log = createLogger("MaintenanceScheduler");
/**
 * Maintenance Scheduler
 * - Periodically purges expired guest manage tokens
 * - Periodically purges old audit logs based on retention policy
 */
import GuestRegistration from "../models/GuestRegistration";
import AuditLog from "../models/AuditLog";
import { alumniRetentionCleanupService } from "./alumni/AlumniRetentionCleanupService";
import { alumniOutcomeDeadlineService } from "./alumni/AlumniOutcomeDeadlineService";
import { chatUnreadReconciliationService } from "./chat/ChatUnreadReconciliationService";
import {
  WORKER_RUN_TRIGGERS,
  WORKER_SERVICE_KEYS,
  workerAuthorizationService,
  type WorkerRunTrigger,
} from "./authorization/WorkerAuthorizationService";

class MaintenanceScheduler {
  private static instance: MaintenanceScheduler;
  private isRunning = false;
  private intervals: NodeJS.Timeout[] = [];
  private initialTimeout: NodeJS.Timeout | null = null;

  public static getInstance(): MaintenanceScheduler {
    if (!MaintenanceScheduler.instance) {
      MaintenanceScheduler.instance = new MaintenanceScheduler();
    }
    return MaintenanceScheduler.instance;
  }

  public start(): void {
    if (this.isRunning) {
      console.log("⚠️ Maintenance scheduler is already running");
      log.warn("Maintenance scheduler already running");
      return;
    }

    // Run every hour
    const hourly = setInterval(async () => {
      await this.purgeExpiredTokens();
      await this.purgeOldAuditLogs();
      await this.purgeAlumniRetentionData(WORKER_RUN_TRIGGERS.SCHEDULED);
      await this.reconcileChatUnread(WORKER_RUN_TRIGGERS.SCHEDULED);
    }, 60 * 60 * 1000);

    this.intervals.push(hourly);
    this.scheduleAlumniOutcomeConfirmation();
    this.isRunning = true;

    console.log("🧹 Maintenance scheduler started (hourly purge)");
    log.info("Maintenance scheduler started", undefined, {
      cadence: "hourly purge",
    });
    // Trigger an initial purge shortly after startup
    this.initialTimeout = setTimeout(async () => {
      this.initialTimeout = null;
      await this.purgeExpiredTokens();
      await this.purgeOldAuditLogs();
      await this.purgeAlumniRetentionData(WORKER_RUN_TRIGGERS.STARTUP);
      await this.reconcileChatUnread(WORKER_RUN_TRIGGERS.STARTUP);
    }, 10 * 1000);
  }

  public stop(): void {
    if (!this.isRunning) {
      console.log("⚠️ Maintenance scheduler is not running");
      log.warn("Maintenance scheduler not running");
      return;
    }
    this.intervals.forEach(clearInterval);
    this.intervals = [];
    if (this.initialTimeout) {
      clearTimeout(this.initialTimeout);
      this.initialTimeout = null;
    }
    this.isRunning = false;
    console.log("🛑 Maintenance scheduler stopped");
    log.info("Maintenance scheduler stopped");
  }

  private async purgeExpiredTokens() {
    try {
      await (
        GuestRegistration as unknown as {
          purgeExpiredManageTokens?: () => Promise<void>;
        }
      ).purgeExpiredManageTokens?.();
      console.log("🧽 Purged expired guest manage tokens (unset)");
      log.info("Purged expired guest manage tokens", undefined, {
        mode: "unset",
      });
    } catch (err) {
      console.error("Failed to purge expired manage tokens:", err);
      log.error(
        "Failed to purge expired manage tokens",
        err instanceof Error ? err : undefined,
        undefined,
        { error: err instanceof Error ? err.message : String(err) }
      );
    }
  }

  private async purgeOldAuditLogs() {
    try {
      const result = await (
        AuditLog as unknown as {
          purgeOldAuditLogs?: () => Promise<{ deletedCount: number }>;
        }
      ).purgeOldAuditLogs?.();

      if (result && result.deletedCount > 0) {
        console.log(`🗂️ Purged ${result.deletedCount} old audit logs`);
        log.info("Purged old audit logs", undefined, {
          deletedCount: result.deletedCount,
          retentionMonths: parseInt(
            process.env.AUDIT_LOG_RETENTION_MONTHS || "12",
            10
          ),
        });
      } else {
        // Only log if there were logs to check (avoid spam in empty systems)
        const totalCount = await AuditLog.countDocuments({});
        if (totalCount > 0) {
          console.log("🗂️ No old audit logs to purge");
          log.info("No old audit logs to purge", undefined, {
            totalAuditLogs: totalCount,
            retentionMonths: parseInt(
              process.env.AUDIT_LOG_RETENTION_MONTHS || "12",
              10
            ),
          });
        }
      }
    } catch (err) {
      console.error("Failed to purge old audit logs:", err);
      log.error(
        "Failed to purge old audit logs",
        err instanceof Error ? err : undefined,
        undefined,
        { error: err instanceof Error ? err.message : String(err) }
      );
    }
  }

  private async purgeAlumniRetentionData(trigger: WorkerRunTrigger) {
    try {
      const runContext = workerAuthorizationService.createRunContext(
        WORKER_SERVICE_KEYS.ALUMNI_RETENTION,
        trigger,
      );
      const result = await alumniRetentionCleanupService.runBounded(runContext);
      if (
        result.importCandidatesScanned > 0 ||
        result.invitationCandidatesScanned > 0
      ) {
        log.info("Completed bounded alumni retention cleanup", undefined, {
          importCandidatesScanned: result.importCandidatesScanned,
          importBatchesPurged: result.importBatchesPurged,
          invitationCandidatesScanned: result.invitationCandidatesScanned,
          invitationsPurged: result.invitationsPurged,
        });
      }
    } catch (error) {
      const candidate = error as { name?: unknown; code?: unknown };
      log.error(
        "Failed to execute alumni retention cleanup",
        new Error("Alumni retention cleanup failed"),
        undefined,
        {
          errorName:
            typeof candidate?.name === "string" ? candidate.name : "UnknownError",
          ...(typeof candidate?.code === "string" ||
          typeof candidate?.code === "number"
            ? { errorCode: candidate.code }
            : {}),
        },
      );
    }
  }

  private scheduleAlumniOutcomeConfirmation(): void {
    const execute = (trigger: WorkerRunTrigger) => {
      void this.confirmDueAlumniOutcomes(trigger);
    };
    const interval = setInterval(
      () => execute(WORKER_RUN_TRIGGERS.SCHEDULED),
      60 * 1000,
    );
    const startup = setTimeout(
      () => execute(WORKER_RUN_TRIGGERS.STARTUP),
      10 * 1000,
    );
    this.intervals.push(interval, startup);
    log.info("Alumni outcome confirmation scheduled", undefined, {
      cadence: "every minute",
    });
  }

  private async reconcileChatUnread(trigger: WorkerRunTrigger) {
    try {
      const runContext = workerAuthorizationService.createRunContext(
        WORKER_SERVICE_KEYS.CHAT_UNREAD,
        trigger,
      );
      const result = await chatUnreadReconciliationService.runBounded(
        runContext,
      );
      if (result.candidatesScanned > 0) {
        log.info("Completed bounded chat unread reconciliation", undefined, {
          candidatesScanned: result.candidatesScanned,
          reconciled: result.reconciled,
          corrected: result.corrected,
          racedOrUnavailable: result.racedOrUnavailable,
          hasMore: result.hasMore,
          capacityPerRun: result.capacityPerRun,
        });
      }
    } catch (error) {
      const candidate = error as { name?: unknown; code?: unknown };
      log.error(
        "Failed to execute chat unread reconciliation",
        new Error("Chat unread reconciliation failed"),
        undefined,
        {
          errorName:
            typeof candidate?.name === "string"
              ? candidate.name
              : "UnknownError",
          ...(typeof candidate?.code === "string" ||
          typeof candidate?.code === "number"
            ? { errorCode: candidate.code }
            : {}),
        },
      );
    }
  }

  private async confirmDueAlumniOutcomes(trigger: WorkerRunTrigger) {
    try {
      const runContext = workerAuthorizationService.createRunContext(
        WORKER_SERVICE_KEYS.ALUMNI_OUTCOME,
        trigger,
      );
      const result = await alumniOutcomeDeadlineService.runBounded(runContext);
      if (result.candidatesScanned > 0) {
        log.info("Completed bounded alumni outcome confirmation", undefined, {
          candidatesScanned: result.candidatesScanned,
          automaticallyConfirmed: result.automaticallyConfirmed,
          racedOrUnavailable: result.racedOrUnavailable,
          remainingOverdue: result.remainingOverdue,
        });
      }
    } catch (error) {
      const candidate = error as { name?: unknown; code?: unknown };
      log.error(
        "Failed to execute alumni outcome confirmation",
        new Error("Alumni outcome confirmation failed"),
        undefined,
        {
          errorName:
            typeof candidate?.name === "string" ? candidate.name : "UnknownError",
          ...(typeof candidate?.code === "string" ||
          typeof candidate?.code === "number"
            ? { errorCode: candidate.code }
            : {}),
        },
      );
    }
  }
}

export default MaintenanceScheduler;
