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
  const activeHealthCheckKeys =
    backendService.match(/^[ \t]*healthCheckPath\s*:/gm) || [];
  if (activeHealthCheckKeys.length !== 1) {
    fail(
      "render.yaml backend service: expected exactly one active healthCheckPath key.",
    );
  }
  const activeReadinessPaths =
    backendService.match(
      /^[ \t]*healthCheckPath:\s*\/api\/readiness\s*$/gm,
    ) || [];
  if (activeReadinessPaths.length !== 1) {
    fail(
      "render.yaml backend service: expected exactly one active /api/readiness healthCheckPath.",
    );
  }
  const activeInstanceKeys =
    backendService.match(/^[ \t]*numInstances\s*:/gm) || [];
  const singleInstanceValues =
    backendService.match(/^[ \t]*numInstances:\s*1\s*$/gm) || [];
  if (activeInstanceKeys.length !== 1 || singleInstanceValues.length !== 1) {
    fail(
      "render.yaml backend service: expected exactly one active numInstances: 1 setting.",
    );
  }
  for (const [key, expectedValue] of [
    ["NODE_ENV", "production"],
    ["WEB_CONCURRENCY", "1"],
    ["SINGLE_INSTANCE_ENFORCE", "true"],
    ["SCHEDULER_ENABLED", "true"],
    ["MONGO_TRANSACTIONS_REQUIRED", "true"],
    ["NOTIFICATION_OUTBOX_ENABLED", "true"],
    ["ALUMNI_NETWORK_RELEASE_AVAILABLE", "false"],
    ["WEB_PUSH_ENABLED", "false"],
  ]) {
    const keyPattern = new RegExp(
      `^[ \\t]*- key:\\s*${key}\\s*$`,
      "gm",
    );
    const valuePattern = new RegExp(
      `^[ \\t]*- key:\\s*${key}\\s*\\r?\\n[ \\t]*value:\\s*${expectedValue}\\s*$`,
      "gm",
    );
    if ((backendService.match(keyPattern) || []).length !== 1) {
      fail(
        `render.yaml backend service: expected exactly one active ${key} key.`,
      );
    }
    if ((backendService.match(valuePattern) || []).length !== 1) {
      fail(
        `render.yaml backend service: expected ${key}=${expectedValue}.`,
      );
    }
  }
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
      /key:\s*NOTIFICATION_OUTBOX_ENABLED\s*\n\s*value:\s*true/,
      "durable outbox delivery must remain enabled after the versioned invitation handler is registered.",
    ],
    [
      /^[ \t]*healthCheckPath:\s*\/api\/readiness\s*$/m,
      "backend health checks must use the dependency-aware readiness endpoint.",
    ],
    [
      /^[ \t]*- key:\s*ALUMNI_NETWORK_RELEASE_AVAILABLE\s*\r?\n[ \t]*value:\s*false\s*$/m,
      "the Alumni Network deployment ceiling must default to disabled.",
    ],
    [
      /key:\s*WEB_PUSH_ENABLED\s*\n\s*value:\s*false/,
      "Web Push must default to disabled until backend-only VAPID secrets are provisioned.",
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

function checkPwaDeliveryContract() {
  const renderYaml = read("render.yaml");
  const frontendService = renderServiceBlock(renderYaml, "atcloud-frontend");
  const backendEnvExample = read("backend/.env.example");
  const frontendEnvExample = read("frontend/.env.example");
  const frontendCsp = read("frontend/src/config/contentSecurityPolicy.ts");
  const frontendVite = read("frontend/vite.config.ts");

  for (const setting of [
    "WEB_PUSH_ENABLED=false",
    "VAPID_SUBJECT=",
    "VAPID_PUBLIC_KEY=",
    "VAPID_PRIVATE_KEY=",
  ]) {
    if (!backendEnvExample.includes(setting)) {
      fail(`backend/.env.example: missing Web Push setting ${setting}.`);
    }
  }

  if (
    frontendEnvExample.includes("VAPID_PRIVATE_KEY") ||
    frontendService.includes("VAPID_PRIVATE_KEY") ||
    /VITE_[A-Z0-9_]*VAPID/.test(frontendEnvExample)
  ) {
    fail(
      "Web Push: the VAPID private key must remain backend-only and must never use a VITE_ variable.",
    );
  }

  for (const setting of [
    "VAPID_SUBJECT",
    "VAPID_PUBLIC_KEY",
    "VAPID_PRIVATE_KEY",
  ]) {
    if (!renderYaml.includes(`# - ${setting}`)) {
      fail(
        `render.yaml backend service: document ${setting} as a manually provisioned Render setting.`,
      );
    }
  }

  for (const directive of [
    '["worker-src", "\'self\'"]',
    '["manifest-src", "\'self\'"]',
  ]) {
    if (!frontendCsp.includes(directive)) {
      fail(`frontend CSP: missing ${directive}.`);
    }
  }

  if (
    !frontendCsp.includes("getProductionBackendOrigins") ||
    !frontendCsp.includes('url.protocol === "https:"') ||
    !frontendCsp.includes("allowExplicitLoopback = false") ||
    !frontendCsp.includes('url.hostname === "127.0.0.1"') ||
    !frontendCsp.includes(
      "getProductionBackendOrigins(apiUrl, allowExplicitLoopback)",
    ) ||
    !frontendVite.includes("isGuardedFullstackLoopbackBuild") ||
    !frontendVite.includes("FULLSTACK_E2E_BACKEND_URL") ||
    !frontendVite.includes("FULLSTACK_E2E_FRONTEND_URL") ||
    !frontendVite.includes("FULLSTACK_E2E_MONGODB_URI")
  ) {
    fail(
      "frontend CSP: production connections must use HTTPS, with numeric loopback limited to the guarded full-stack E2E build.",
    );
  }

  for (const [pathName, header, value] of [
    ["/*", "X-Content-Type-Options", "nosniff"],
    ["/*", "Referrer-Policy", "strict-origin-when-cross-origin"],
    ["/*", "X-Frame-Options", "SAMEORIGIN"],
    ["/*", "Strict-Transport-Security", "max-age=31536000; includeSubDomains"],
    ["/*", "Permissions-Policy", "camera=(), geolocation=(), microphone=()"],
    ["/assets/*", "Cache-Control", "public, max-age=31536000, immutable"],
    ["/sw.js", "Cache-Control", "no-cache, no-store, must-revalidate"],
    ["/manifest.json", "Cache-Control", "no-cache, no-store, must-revalidate"],
  ]) {
    const rule = `- path: ${pathName}\n        name: ${header}\n        value: ${value}`;
    if (!frontendService.includes(rule)) {
      fail(
        `render.yaml frontend service: missing static header ${header} for ${pathName}.`,
      );
    }
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
checkPwaDeliveryContract();

if (failures.length > 0) {
  console.error("Deployment guardrail check failed:\n");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Deployment guardrail check passed.");
