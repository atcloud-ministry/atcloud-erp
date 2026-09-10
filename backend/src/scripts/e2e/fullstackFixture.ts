import mongoose from "mongoose";
import User from "../../models/User";

const SAFE_DATABASE_NAME = /^atcloud_fullstack_e2e_[a-zA-Z0-9_-]{1,40}$/;
const REQUIRED_HOST = "127.0.0.1";
const REQUIRED_PORT = "27018";
const REQUIRED_REPLICA_SET = "rs0";

type FixtureCommand = "seed" | "cleanup";

interface FixtureConfiguration {
  readonly command: FixtureCommand;
  readonly uri: string;
  readonly databaseName: string;
  readonly username: string;
  readonly email: string;
  readonly password: string;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function parseCommand(argv: readonly string[]): FixtureCommand {
  if (argv.length !== 1 || (argv[0] !== "seed" && argv[0] !== "cleanup")) {
    throw new Error("Usage: e2e:fixture -- seed|cleanup");
  }
  return argv[0];
}

function parseGuardedMongoUri(rawUri: string): {
  readonly uri: string;
  readonly databaseName: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(rawUri);
  } catch {
    throw new Error("FULLSTACK_E2E_MONGODB_URI must be a valid MongoDB URI.");
  }

  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  const hasSingleDatabasePath =
    parsed.pathname.startsWith("/") &&
    parsed.pathname.length > 1 &&
    !databaseName.includes("/");

  if (
    parsed.protocol !== "mongodb:" ||
    parsed.hostname !== REQUIRED_HOST ||
    parsed.port !== REQUIRED_PORT ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    !hasSingleDatabasePath ||
    !SAFE_DATABASE_NAME.test(databaseName) ||
    parsed.searchParams.get("replicaSet") !== REQUIRED_REPLICA_SET
  ) {
    throw new Error(
      "Fixture MongoDB URI must target the loopback rs0 test service and a guarded fullstack_e2e database.",
    );
  }

  return { uri: rawUri, databaseName };
}

function loadConfiguration(argv: readonly string[]): FixtureConfiguration {
  if (process.env.NODE_ENV !== "fullstack-e2e") {
    throw new Error(
      "Full-stack E2E fixtures require NODE_ENV=fullstack-e2e with real JWT authentication.",
    );
  }

  const command = parseCommand(argv);
  const target = parseGuardedMongoUri(
    requiredEnvironment("FULLSTACK_E2E_MONGODB_URI"),
  );

  return {
    command,
    ...target,
    username: requiredEnvironment("FULLSTACK_E2E_USERNAME"),
    email: requiredEnvironment("FULLSTACK_E2E_EMAIL").toLowerCase(),
    password: requiredEnvironment("FULLSTACK_E2E_PASSWORD"),
  };
}

async function dropGuardedDatabase(databaseName: string): Promise<void> {
  const database = mongoose.connection.db;
  const connectedName = database?.databaseName;
  if (
    !database ||
    connectedName !== databaseName ||
    !SAFE_DATABASE_NAME.test(connectedName)
  ) {
    throw new Error("Refusing to drop an unguarded database.");
  }
  await database.dropDatabase();
}

async function seed(configuration: FixtureConfiguration): Promise<void> {
  await dropGuardedDatabase(configuration.databaseName);
  await User.init();

  const user = await User.create({
    username: configuration.username,
    email: configuration.email,
    password: configuration.password,
    firstName: "Fullstack",
    lastName: "Operator",
    gender: "male",
    isAtCloudLeader: true,
    roleInAtCloud: "Super Admin",
    role: "Super Admin",
    isActive: true,
    isVerified: true,
    emailNotifications: false,
    hasReceivedWelcomeMessage: true,
  });

  process.stdout.write(
    `${JSON.stringify({
      success: true,
      action: "seed",
      database: configuration.databaseName,
      userId: String(user._id),
    })}\n`,
  );
}

async function cleanup(configuration: FixtureConfiguration): Promise<void> {
  await dropGuardedDatabase(configuration.databaseName);
  process.stdout.write(
    `${JSON.stringify({
      success: true,
      action: "cleanup",
      database: configuration.databaseName,
    })}\n`,
  );
}

async function main(): Promise<void> {
  const configuration = loadConfiguration(process.argv.slice(2));
  await mongoose.connect(configuration.uri, {
    autoIndex: true,
    maxPoolSize: 2,
    serverSelectionTimeoutMS: 10_000,
  });

  try {
    if (configuration.command === "seed") {
      await seed(configuration);
    } else {
      await cleanup(configuration);
    }
  } finally {
    await mongoose.connection.close();
  }
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Unknown fixture error.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
