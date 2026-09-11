import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { createServer } from "http";
import { setupSwagger } from "./config/swagger";
import { socketService } from "./services/infrastructure/SocketService";
import EventReminderScheduler from "./services/EventReminderScheduler";
import MaintenanceScheduler from "./services/MaintenanceScheduler";
import { SchedulerService } from "./services/SchedulerService";
import app from "./app";
import { lockService } from "./services/LockService";
import { createLogger } from "./services/LoggerService";
import {
  initializeAlumniDataModels,
  SystemConfig,
} from "./models"; // Import models required during startup
import { TokenService } from "./middleware/auth";
import { isSchedulerEnabled } from "./config/scheduler";
import { reliabilityFoundationService } from "./services/reliability/ReliabilityFoundationService";
import { readHttpBindHost } from "./config/httpBinding";

const log = createLogger("App");

// Load environment variables
dotenv.config();

// Ensure upload directories exist
const ensureUploadDirectories = () => {
  let baseUploadPath: string;
  if (process.env.UPLOAD_DESTINATION) {
    baseUploadPath = process.env.UPLOAD_DESTINATION.replace(/\/$/, "");
  } else {
    baseUploadPath =
      process.env.NODE_ENV === "production" ? "/uploads" : "uploads";
  }
  const uploadDirs = [baseUploadPath, path.join(baseUploadPath, "avatars")];
  uploadDirs.forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`📁 Created upload directory: ${dir}`);
      log.info("Created upload directory", undefined, { dir });
    } else {
      console.log(`✅ Upload directory exists: ${dir}`);
      log.debug("Upload directory exists", undefined, { dir });
    }
  });
};

const httpServer = createServer(app);
const PORT = process.env.PORT || 5001;
const HTTP_BIND_HOST = readHttpBindHost();
const HTTP_DRAIN_TIMEOUT_MS = 8_000;
let shutdownPromise: Promise<void> | null = null;

const classifyOperationalError = (error: unknown) => {
  const candidate = error as { name?: unknown; code?: unknown };
  return {
    name:
      typeof candidate?.name === "string" ? candidate.name : "UnknownError",
    ...(typeof candidate?.code === "string" ||
    typeof candidate?.code === "number"
      ? { code: candidate.code }
      : {}),
  };
};

const drainHttpServer = async (): Promise<void> => {
  if (!httpServer.listening) return;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      console.warn(
        `HTTP drain exceeded ${HTTP_DRAIN_TIMEOUT_MS}ms; closing remaining connections`,
      );
      httpServer.closeAllConnections?.();
      finish();
    }, HTTP_DRAIN_TIMEOUT_MS);
    timeout.unref?.();

    try {
      httpServer.close((error) => finish(error));
      httpServer.closeIdleConnections?.();
    } catch (error) {
      finish(error instanceof Error ? error : new Error("HTTP drain failed"));
    }
  });
};

const listenHttpServer = async (): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      httpServer.off("error", onError);
      reject(error);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      resolve();
    };

    httpServer.once("error", onError);
    if (HTTP_BIND_HOST) {
      httpServer.listen(Number(PORT), HTTP_BIND_HOST, onListening);
    } else {
      httpServer.listen(PORT, onListening);
    }
  });
};

const cleanupAfterStartupFailure = async (): Promise<void> => {
  const httpDrain = drainHttpServer();
  const socketDrain = socketService.shutdown();
  await Promise.allSettled([httpDrain, socketDrain]);
  await reliabilityFoundationService.stop().catch(() => undefined);
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close().catch(() => undefined);
  }
};

// Guard: In-memory lock requires single backend instance. Warn or fail fast based on env.
const enforceSingleInstanceIfNecessary = () => {
  const impl = (lockService as any)?.constructor?.name || "Unknown";
  const usingInMemory = impl === "InMemoryLockService";
  if (!usingInMemory) return; // Only applies to in-memory lock

  const webConcurrency = parseInt(process.env.WEB_CONCURRENCY || "1", 10);
  const pm2Cluster = process.env.PM2_CLUSTER_MODE === "true";
  const nodeAppInstance = process.env.NODE_APP_INSTANCE;
  const inferredConcurrency = Math.max(
    1,
    isNaN(webConcurrency) ? 1 : webConcurrency,
    pm2Cluster ? 2 : 1,
    nodeAppInstance ? 2 : 1
  );

  const enforce = process.env.SINGLE_INSTANCE_ENFORCE === "true";

  if (inferredConcurrency > 1) {
    const msg =
      "InMemoryLockService requires a single backend instance. Detected concurrent workers/processes via env.";
    if (enforce) {
      console.error(`❌ ${msg} Set WEB_CONCURRENCY=1 and disable cluster/PM2.`);
      log.error(
        "In-memory lock requires single instance; failing fast",
        undefined,
        undefined,
        {
          msg,
          webConcurrency,
          pm2Cluster,
          nodeAppInstance,
        }
      );
      process.exit(1);
    } else {
      console.warn(
        `⚠️ ${msg} Set SINGLE_INSTANCE_ENFORCE=true to fail-fast in production.`
      );
      log.warn(
        "In-memory lock requires single instance; warning only",
        undefined,
        {
          msg,
          webConcurrency,
          pm2Cluster,
          nodeAppInstance,
        }
      );
    }
  }

  console.log(
    `🔒 Lock implementation: ${impl} | SINGLE_INSTANCE_ENFORCE=${
      process.env.SINGLE_INSTANCE_ENFORCE || "false"
    }`
  );
  log.info("Lock implementation info", undefined, {
    impl,
    singleInstanceEnforce: process.env.SINGLE_INSTANCE_ENFORCE || "false",
  });
};
// Database connection
const connectDB = async () => {
  try {
    const mongoURI =
      process.env.MONGODB_URI || "mongodb://localhost:27017/atcloud-signup";

    await mongoose.connect(mongoURI);
    console.log("✅ Connected to MongoDB successfully");
    log.info("Connected to MongoDB successfully", undefined, {
      mongoURI: mongoURI.replace(/:\/\/.*@/, "://***@"),
    });

    // Try to get MongoDB version
    try {
      const db = mongoose.connection.db;
      if (db) {
        const admin = db.admin();
        const dbInfo = await admin.serverStatus();
        console.log(`📊 MongoDB version: ${dbInfo.version}`);
        log.info("MongoDB server status", undefined, {
          version: dbInfo.version,
        });
      }
    } catch (dbInfoError) {
      console.warn("⚠️ Could not fetch MongoDB info:", dbInfoError);
      log.warn("Could not fetch MongoDB info", undefined, {
        error: String(dbInfoError),
      });
    }

    // Initialize system configurations
    try {
      await SystemConfig.initializeDefaults();
      console.log("✅ System configurations initialized");
      log.info("System configurations initialized");
    } catch (configError) {
      console.error(
        "⚠️ Failed to initialize system configurations:",
        configError
      );
      log.error(
        "Failed to initialize system configurations",
        configError as Error
      );
      // Non-blocking - server can still start
    }
  } catch (error) {
    console.error("❌ MongoDB connection failed:", error);
    log.error("MongoDB connection failed", error as Error);
    process.exit(1);
  }
};

// Graceful shutdown
const performGracefulShutdown = async () => {
  try {
    // Refuse new HTTP/Socket work before stopping producers and draining the
    // bounded outbox worker. The worker keeps unfinished leases recoverable.
    const httpDrain = drainHttpServer();
    const socketDrain = socketService.shutdown();

    // Stop event reminder scheduler
    const scheduler = EventReminderScheduler.getInstance();
    scheduler.stop();

    // Stop maintenance scheduler
    const maintenance = MaintenanceScheduler.getInstance();
    maintenance.stop();

    // Stop message cleanup scheduler
    SchedulerService.stop();

    // Existing request producers must finish before the outbox worker drains.
    await Promise.all([httpDrain, socketDrain]);
    await reliabilityFoundationService.stop();
    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    const classification = classifyOperationalError(error);
    console.error("Error during graceful shutdown:", classification);
    log.error("Graceful shutdown failed", undefined, undefined, classification);
    process.exit(1);
  }
};

const gracefulShutdown = (): Promise<void> => {
  if (!shutdownPromise) shutdownPromise = performGracefulShutdown();
  return shutdownPromise;
};

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

// Start server
const startServer = async () => {
  try {
    // Never start production HTTP/Socket authentication with fallback secrets.
    TokenService.assertProductionConfiguration();

    // Validate runtime concurrency constraints for in-memory locking
    enforceSingleInstanceIfNecessary();

    // Ensure upload directories exist
    ensureUploadDirectories();

    await connectDB();

    // Verify transaction support and initialize reliability indexes before
    // accepting traffic. Production failures abort startup.
    await reliabilityFoundationService.initialize();
    console.log("✅ Reliability foundation initialized");
    log.info("Reliability foundation initialized");

    // These collections are new and empty when M2 first deploys. Waiting for
    // model initialization makes unique and retention index failures fail the
    // deployment before HTTP/Socket traffic is accepted.
    await initializeAlumniDataModels();
    console.log("✅ Alumni data models initialized");
    log.info("Alumni data models initialized");

    // Initialize WebSocket server
    socketService.initialize(httpServer);

    // Setup API documentation
    setupSwagger(app);

    // Confirm the HTTP listener before any background worker can claim work.
    await listenHttpServer();

    reliabilityFoundationService.start();
    if (
      reliabilityFoundationService.getStatusSnapshot().notificationOutbox
        .workerStarted
    ) {
      console.log("📤 Notification outbox worker active");
      log.info("Notification outbox worker active");
    }

    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🔗 API Readiness: http://localhost:${PORT}/api/readiness`);
    console.log(`🔗 API Liveness: http://localhost:${PORT}/api/readiness/live`);
    console.log(`🔗 Legacy Health (kept): http://localhost:${PORT}/health`);
    console.log(`📚 API Documentation: http://localhost:${PORT}/api-docs`);
    console.log(`🔌 WebSocket ready for real-time notifications`);
    log.info("Server started", undefined, {
      port: PORT,
      readiness: `/api/readiness`,
      liveness: `/api/readiness/live`,
      compatibilityHealth: `/api/health`,
      legacyHealth: `/health`,
      docs: `/api-docs`,
      websocket: true,
    });

    // Start event reminder scheduler
    const schedulerEnabled = isSchedulerEnabled();
    if (schedulerEnabled) {
      const scheduler = EventReminderScheduler.getInstance();
      scheduler.start();
      console.log(`⏰ Event reminder scheduler active`);
      log.info("Event reminder scheduler active");
    } else {
      console.log(
        `⏸️ Event reminder scheduler disabled by env (SCHEDULER_ENABLED!=true)`,
      );
      log.info("Event reminder scheduler disabled by env", undefined, {
        SCHEDULER_ENABLED: process.env.SCHEDULER_ENABLED,
      });
    }

    // Start maintenance scheduler
    const maintenance = MaintenanceScheduler.getInstance();
    maintenance.start();
    log.info("Maintenance scheduler started");

    // Start message cleanup scheduler (automated daily cleanup at 2 AM)
    if (schedulerEnabled) {
      SchedulerService.start();
      console.log(`🧹 Message cleanup scheduler active (daily at 2:00 AM)`);
      log.info("Message cleanup scheduler started");
    }
  } catch (error) {
    await cleanupAfterStartupFailure();
    const classification = classifyOperationalError(error);
    console.error("❌ Failed to start server:", classification);
    log.error("Failed to start server", undefined, undefined, classification);
    process.exit(1);
  }
};

startServer();
