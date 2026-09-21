#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const rootLockPath = path.join(repositoryRoot, "package-lock.json");
const workspaceLockPaths = [
  path.join(repositoryRoot, "backend", "package-lock.json"),
  path.join(repositoryRoot, "frontend", "package-lock.json"),
];
const repair = process.argv.includes("--repair");

function readLockfile(lockPath) {
  return JSON.parse(fs.readFileSync(lockPath, "utf8"));
}

function moduleSearchPaths(from, name) {
  const parts = from ? from.split("/") : [];
  const candidates = [];

  for (let index = parts.length; index >= 0; index -= 1) {
    if (index > 0 && parts[index - 1] === "node_modules") continue;

    const prefix = parts.slice(0, index).join("/");
    candidates.push(
      `${prefix ? `${prefix}/` : ""}node_modules/${name}`,
    );
  }

  return [...new Set(candidates)];
}

function repairPackagePath(from, name) {
  const workspace = from.split("/", 1)[0];
  if (["backend", "frontend", "shared"].includes(workspace)) {
    return `${workspace}/node_modules/${name}`;
  }

  return `node_modules/${name}`;
}

function requiresExactLockVersion(versionRange) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(
    versionRange,
  );
}

function findOptionalDependencyProblems(lockfile) {
  const problems = [];

  for (const [from, packageRecord] of Object.entries(lockfile.packages)) {
    for (const [name, expectedVersion] of Object.entries(
      packageRecord.optionalDependencies ?? {},
    )) {
      const packagePath = moduleSearchPaths(from, name).find(
        (candidate) => lockfile.packages[candidate] !== undefined,
      );
      if (!packagePath) {
        problems.push({
          type: "missing",
          from,
          name,
          expectedVersion,
          packagePath: repairPackagePath(from, name),
        });
        continue;
      }

      const actualVersion = lockfile.packages[packagePath].version;
      if (
        requiresExactLockVersion(expectedVersion) &&
        actualVersion !== expectedVersion
      ) {
        problems.push({
          type: "version_mismatch",
          from,
          name,
          expectedVersion,
          actualVersion,
          packagePath,
        });
      }
    }
  }

  return problems;
}

function findMatchingWorkspaceRecord(workspaceLocks, missingRecord) {
  for (const lockfile of workspaceLocks) {
    const candidate = lockfile.packages[missingRecord.packagePath];
    if (candidate?.version === missingRecord.expectedVersion) {
      return candidate;
    }
  }

  return undefined;
}

function formatProblems(problems) {
  return problems
    .map((problem) => {
      const expected = `${problem.name}@${problem.expectedVersion}`;
      if (problem.type === "version_mismatch") {
        return `- ${problem.from}: ${expected} resolves to ${problem.packagePath}@${problem.actualVersion}`;
      }
      return `- ${problem.from}: ${expected}`;
    })
    .join("\n");
}

const rootLock = readLockfile(rootLockPath);
const problemsBeforeRepair = findOptionalDependencyProblems(rootLock);

if (repair && problemsBeforeRepair.length > 0) {
  const versionMismatches = problemsBeforeRepair.filter(
    (problem) => problem.type === "version_mismatch",
  );
  if (versionMismatches.length > 0) {
    console.error(
      "Unable to repair root package-lock.json because optional dependencies resolve to the wrong version:\n" +
        formatProblems(versionMismatches),
    );
    process.exit(1);
  }

  const workspaceLocks = workspaceLockPaths.map(readLockfile);
  const unrecoverable = [];

  for (const missingRecord of problemsBeforeRepair) {
    const sourceRecord = findMatchingWorkspaceRecord(
      workspaceLocks,
      missingRecord,
    );
    if (!sourceRecord) {
      unrecoverable.push(missingRecord);
      continue;
    }

    rootLock.packages[missingRecord.packagePath] = structuredClone(sourceRecord);
  }

  if (unrecoverable.length > 0) {
    console.error(
      "Unable to repair root package-lock.json because matching workspace records were not found:\n" +
        formatProblems(unrecoverable),
    );
    process.exit(1);
  }

  fs.writeFileSync(rootLockPath, `${JSON.stringify(rootLock, null, 2)}\n`);
}

const problemsAfterRepair = findOptionalDependencyProblems(
  repair ? readLockfile(rootLockPath) : rootLock,
);

if (problemsAfterRepair.length > 0) {
  console.error(
    "Root package-lock.json has invalid optional dependency records:\n" +
      formatProblems(problemsAfterRepair),
  );
  console.error(
    "Regenerate a portable lockfile, or run this script with --repair when matching workspace records are available.",
  );
  process.exit(1);
}

if (repair) {
  console.log(
    `Repaired root package-lock.json with ${problemsBeforeRepair.length} optional platform package record(s).`,
  );
} else {
  console.log("Root package-lock optional platform dependency records are complete.");
}
