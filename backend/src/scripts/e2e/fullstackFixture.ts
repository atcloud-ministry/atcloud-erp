import mongoose from "mongoose";
import User from "../../models/User";
import AlumniProfile from "../../models/AlumniProfile";
import AlumniAffiliation from "../../models/AlumniAffiliation";
import ConsentRecord from "../../models/ConsentRecord";
import { ALUMNI_PROFILE_PUBLICATION_CONSENT } from "../../config/alumniProfilePublicationConsent";
import { deriveAlumniAffiliationKey } from "../../contracts/alumniDirectoryData";

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
  await User.createCollection();
  await User.createIndexes();

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
    phone: "+12065550100",
    birthYear: 1988,
    residenceCity: "Seattle",
    residenceRegion: "US-WA",
    residenceCountryCode: "US",
    employmentStatus: "employed",
    company: "E2E Test Organization",
    occupation: "Engineer",
  });

  const helper = await User.create({
    username: "e2e_alumni_helper",
    email: "alumni.helper.e2e@example.com",
    password: configuration.password,
    firstName: "Alumni",
    lastName: "Helper",
    gender: "female",
    isAtCloudLeader: false,
    role: "Participant",
    isActive: true,
    isVerified: true,
    emailNotifications: false,
    hasReceivedWelcomeMessage: true,
    phone: "+12065550101",
    birthYear: 1989,
    residenceCity: "Seattle",
    residenceRegion: "US-WA",
    residenceCountryCode: "US",
    employmentStatus: "employed",
    company: "E2E Test Organization",
    occupation: "Mentor",
  });
  const now = new Date();
  const profileId = new mongoose.Types.ObjectId("64b00000000000000000ee01");
  const consentId = new mongoose.Types.ObjectId();
  await AlumniProfile.collection.insertOne({
    _id: profileId,
    userId: helper._id,
    professionalHeadline: "E2E career mentor",
    industry: "Technology",
    skills: ["Mentoring"],
    bio: "Controlled full-stack test helper",
    helpOfferings: { careerAdvice: true, warmIntroduction: true, formalEmployeeReferral: true },
    publishStatus: "published",
    currentPublicationConsentId: consentId,
    searchProjection: {},
    publishedAt: now,
    withdrawnAt: null,
    accountDeletionApprovedAt: null,
    purgeAt: null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  await ConsentRecord.collection.insertOne({
    _id: consentId,
    subjectUserId: helper._id,
    alumniProfileId: profileId,
    purpose: "alumni_profile_publication",
    consentVersion: ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
    documentHash: ALUMNI_PROFILE_PUBLICATION_CONSENT.documentHash,
    status: "active",
    acceptedAt: now,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  });
  await AlumniAffiliation.collection.insertOne({
    _id: new mongoose.Types.ObjectId(),
    alumniProfileId: profileId,
    programName: "E2E Alumni Program",
    cohortLabel: "2026",
    affiliationKey: deriveAlumniAffiliationKey({ programName: "E2E Alumni Program", cohortLabel: "2026" }),
    verificationStatus: "verified",
    reviewedAt: now,
    reviewedBy: user._id,
    accountDeletionApprovedAt: null,
    purgeAt: null,
    revision: 0,
    createdAt: now,
    updatedAt: now,
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
    autoCreate: false,
    autoIndex: false,
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
