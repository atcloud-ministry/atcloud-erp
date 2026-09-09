import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function fail(message) {
  failures.push(message);
}

function assertIncludes(relativePath, needle, message) {
  const text = read(relativePath);
  if (!text.includes(needle)) {
    fail(`${relativePath}: ${message}`);
  }
}

function lineNumber(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function renderServiceBlock(renderYaml, serviceName) {
  const nameMarker = `    name: ${serviceName}`;
  const nameIndex = renderYaml.indexOf(nameMarker);
  if (nameIndex < 0) return "";
  const blockStart = renderYaml.lastIndexOf("\n  - type:", nameIndex);
  const nextBlock = renderYaml.indexOf("\n  - type:", nameIndex + nameMarker.length);
  return renderYaml.slice(
    blockStart < 0 ? 0 : blockStart + 1,
    nextBlock < 0 ? renderYaml.length : nextBlock,
  );
}

function listSourceFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(root, absolute);

    if (
      entry.isDirectory() &&
      ![
        "dist",
        "coverage",
        "node_modules",
        "__tests__",
        "test",
        "tests",
      ].includes(entry.name)
    ) {
      files.push(...listSourceFiles(absolute));
      continue;
    }

    if (
      entry.isFile() &&
      /\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.includes(".test.") &&
      !relative.includes(`${path.sep}src${path.sep}test${path.sep}`)
    ) {
      files.push(relative);
    }
  }

  return files;
}

function checkHashRouterContract() {
  const main = read("frontend/src/main.tsx");
  if (!main.includes("HashRouter") || !main.includes("<HashRouter>")) {
    fail("frontend/src/main.tsx: deployed frontend must use HashRouter.");
  }

  assertIncludes(
    "frontend/src/services/session.ts",
    'getHashRouteUrl("/login")',
    "session expiry must redirect to the hash login route.",
  );
  assertIncludes(
    "frontend/src/utils/hashRouting.ts",
    'return `/#${route}`;',
    "hash route helper must produce root hash URLs.",
  );
}

function checkInternalHardNavigations() {
  const sourceRoot = path.join(root, "frontend/src");
  const files = listSourceFiles(sourceRoot);
  const patterns = [
    {
      name: "window.location.href",
      regex: /window\.location\.href\s*=\s*(['"`])([^'"`]+)\1/g,
    },
    {
      name: "window.location.assign",
      regex: /window\.location\.assign\(\s*(['"`])([^'"`]+)\1\s*\)/g,
    },
  ];

  for (const relative of files) {
    if (relative === "frontend/src/utils/hashRouting.ts") continue;
    const text = read(relative);

    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern.regex)) {
        const target = match[2];
        const isInternalDirectPath =
          target.startsWith("/") &&
          !target.startsWith("/#") &&
          !target.startsWith("//");

        if (isInternalDirectPath) {
          fail(
            `${relative}:${lineNumber(text, match.index ?? 0)}: ${pattern.name} hard-navigates to "${target}". Use hardNavigateToHashRoute() for internal app routes.`,
          );
        }
      }
    }
  }
}

function checkAvatarAndUploadContracts() {
  const avatarUtils = read("frontend/src/utils/avatarUtils.ts");
  if (avatarUtils.includes("backend.onrender.com")) {
    fail(
      "frontend/src/utils/avatarUtils.ts: do not special-case one backend hostname; staging and production hostnames differ.",
    );
  }
  if (
    !avatarUtils.includes("import.meta.env.PROD") ||
    !avatarUtils.includes("return customAvatar;")
  ) {
    fail(
      "frontend/src/utils/avatarUtils.ts: production builds must preserve absolute avatar URLs.",
    );
  }

  const uploadMiddleware = read("backend/src/middleware/upload.ts");
  if (
    uploadMiddleware.includes('uploadPath += "avatars/"') ||
    uploadMiddleware.includes('uploadPath += "images/"')
  ) {
    fail(
      "backend/src/middleware/upload.ts: upload directories must use normalized paths, not string concatenation.",
    );
  }
  assertIncludes(
    "backend/src/middleware/upload.ts",
    "path.join(getUploadBasePath(), subdirectory)",
    "upload subdirectories must be joined against the normalized base path.",
  );
}

function checkRenderTemplateContract() {
  const renderYaml = read("render.yaml");
  const backendService = renderServiceBlock(renderYaml, "atcloud-backend");
  for (const required of [
    "type: rewrite",
    "source: /*",
    "destination: /index.html",
    "key: VITE_API_URL",
    "fromService:",
    "envVarKey: RENDER_EXTERNAL_URL",
  ]) {
    if (!renderYaml.includes(required)) {
      fail(`render.yaml: expected frontend static-site contract "${required}".`);
    }
  }

  for (const [pattern, message] of [
    [
      /name:\s*atcloud-backend[\s\S]*?buildCommand:\s*npm ci --include=dev && npm run build --workspace=@atcloud\/shared-time && npm run build --workspace=atcloud-signup-system-backend/,
      "backend build must install from the repository root and compile the shared workspace first.",
    ],
    [
      /name:\s*atcloud-backend[\s\S]*?startCommand:\s*npm start --workspace=atcloud-signup-system-backend/,
      "backend start must target the backend workspace from the repository root.",
    ],
    [
      /name:\s*atcloud-frontend[\s\S]*?buildCommand:\s*npm ci --include=dev && npm run build --workspace=@atcloud\/shared-time && npm run build --workspace=frontend/,
      "frontend build must install from the repository root and compile the shared workspace first.",
    ],
    [
      /name:\s*atcloud-frontend[\s\S]*?staticPublishPath:\s*\.\/frontend\/dist/,
      "frontend publish path must resolve from the repository root.",
    ],
  ]) {
    if (!pattern.test(renderYaml)) {
      fail(`render.yaml: ${message}`);
    }
  }

  for (const [pattern, message] of [
    [
      /numInstances:\s*1/,
      "backend Socket.IO delivery must remain on one Render instance until a distributed adapter is configured.",
    ],
    [
      /key:\s*WEB_CONCURRENCY\s*\n\s*value:\s*1/,
      "backend must use one Node web process for in-memory coordination.",
    ],
    [
      /key:\s*SINGLE_INSTANCE_ENFORCE\s*\n\s*value:\s*true/,
      "single-instance enforcement must be enabled.",
    ],
    [
      /key:\s*SCHEDULER_ENABLED\s*\n\s*value:\s*true/,
      "the single Web Service must explicitly run scheduled workers.",
    ],
    [
      /key:\s*MONGO_TRANSACTIONS_REQUIRED\s*\n\s*value:\s*true/,
      "production must verify MongoDB transaction capability before serving traffic.",
    ],
    [
      /key:\s*NOTIFICATION_OUTBOX_ENABLED\s*\n\s*value:\s*false/,
      "durable outbox delivery must remain disabled until versioned handlers are registered.",
    ],
    [
      /key:\s*JWT_ACCESS_EXPIRE\s*\n\s*value:\s*3h/,
      "access-token expiry must use the TokenService environment key.",
    ],
    [
      /key:\s*JWT_REFRESH_EXPIRE\s*\n\s*value:\s*7d/,
      "refresh-token expiry must use the TokenService environment key.",
    ],
  ]) {
    if (!pattern.test(backendService)) {
      fail(`render.yaml backend service: ${message}`);
    }
  }

  if (/^\s*rootDir:/m.test(renderYaml)) {
    fail(
      "render.yaml: services must retain repository-root access to the shared workspace.",
    );
  }

  if (/property:\s*host/.test(renderYaml)) {
    fail(
      "render.yaml: browser API URLs must use the backend's public RENDER_EXTERNAL_URL.",
    );
  }

  if (/^databases:/m.test(renderYaml) || renderYaml.includes("atcloud-mongodb")) {
    fail(
      "render.yaml: MongoDB Atlas must be supplied through MONGODB_URI, not declared as a Render database.",
    );
  }
}

function checkProductionBuildDependencies() {
  const npmrc = read(".npmrc");
  const includesDevDependencies = npmrc
    .split(/\r?\n/)
    .some((line) => line.trim() === "include=dev");

  if (!includesDevDependencies) {
    fail(
      ".npmrc: Render sets NODE_ENV=production during builds, so npm must explicitly include devDependencies.",
    );
  }
}

checkHashRouterContract();
checkInternalHardNavigations();
checkAvatarAndUploadContracts();
checkRenderTemplateContract();
checkProductionBuildDependencies();

if (failures.length > 0) {
  console.error("Deployment guardrail check failed:\n");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Deployment guardrail check passed.");
