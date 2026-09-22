import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";

const root = process.cwd();
const dist = resolve(root, "dist");

function fail(message) {
  throw new Error(`PWA build verification failed: ${message}`);
}

function read(relativePath) {
  return readFileSync(resolve(dist, relativePath));
}

function assertPng(relativePath, expectedSize) {
  const bytes = read(relativePath);
  const signature = bytes.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") fail(`${relativePath} is not a PNG`);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width !== expectedSize || height !== expectedSize) {
    fail(`${relativePath} must be ${expectedSize}x${expectedSize}`);
  }
}

function assertWhitePngBackground(relativePath) {
  const bytes = read(relativePath);
  if (bytes[24] !== 8 || bytes[25] !== 6) {
    fail(`${relativePath} must be an 8-bit RGBA PNG`);
  }
  const idatChunks = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > bytes.length) fail(`${relativePath} has an invalid PNG chunk`);
    if (type === "IDAT") idatChunks.push(bytes.subarray(offset + 8, end - 4));
    offset = end;
    if (type === "IEND") break;
  }
  if (idatChunks.length === 0) fail(`${relativePath} has no image data`);
  // At the top-left corner every PNG scanline filter has a zero predictor.
  const firstScanline = inflateSync(Buffer.concat(idatChunks));
  if (!firstScanline.subarray(1, 5).equals(Buffer.from([255, 255, 255, 255]))) {
    fail(`${relativePath} must have an opaque white background`);
  }
}

const manifest = JSON.parse(read("manifest.json").toString("utf8"));
const packageJson = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
);
if (manifest.display !== "standalone" || manifest.scope !== "/") {
  fail("manifest must launch standalone at root scope");
}

const requiredIcons = new Map([
  ["/pwa-icon-192.png?v=white-20260922", ["192x192", "any"]],
  ["/pwa-icon-512.png?v=white-20260922", ["512x512", "any"]],
  ["/pwa-maskable-512.png?v=white-20260922", ["512x512", "maskable"]],
]);
for (const [source, [size, purpose]] of requiredIcons) {
  const icon = manifest.icons?.find((candidate) => candidate.src === source);
  if (!icon || icon.sizes !== size || icon.purpose !== purpose) {
    fail(`manifest icon contract is missing for ${source}`);
  }
}

assertPng("pwa-icon-192.png", 192);
assertPng("pwa-icon-512.png", 512);
assertPng("pwa-maskable-512.png", 512);
assertPng("apple-touch-icon.png", 180);
for (const icon of ["pwa-icon-192.png", "pwa-icon-512.png", "pwa-maskable-512.png"]) {
  assertWhitePngBackground(icon);
}

const indexHtml = read("index.html").toString("utf8");
if (
  indexHtml.indexOf('http-equiv="Content-Security-Policy"') < 0 ||
  indexHtml.indexOf('http-equiv="Content-Security-Policy"') >
    indexHtml.indexOf('rel="manifest"')
) {
  fail("the CSP meta element must precede resource-loading elements");
}
if (!indexHtml.includes('rel="manifest" href="/manifest.json"')) {
  fail("index.html does not link the manifest");
}
if (!indexHtml.includes('rel="apple-touch-icon"')) {
  fail("index.html does not expose an Apple touch icon");
}

const offlineHtml = read("offline.html").toString("utf8");
if (!offlineHtml.includes("You are offline")) fail("offline page is missing");
if (!offlineHtml.includes('src="/offline-retry.js"')) {
  fail("offline page must preserve the current URL when retrying");
}

const worker = read("sw.js").toString("utf8");
if (
  worker.includes("__PWA_VERSION__") ||
  worker.includes("__PWA_PRECACHE_MANIFEST__")
) {
  fail("Service Worker build placeholders were not replaced");
}
if (
  !worker.includes(`const SW_VERSION = "${packageJson.version}-`) ||
  !/const SW_VERSION = "[^\"]+-[a-f0-9]{12}";/.test(worker)
) {
  fail("Service Worker does not contain a build-unique version");
}
if (!worker.includes('const PRIVATE_PATH_PREFIXES = ["/api/", "/uploads/", "/s/"]')) {
  fail("Service Worker must keep private endpoints network-only");
}
if (worker.includes("cache.put(APP_SHELL_URL")) {
  fail("live navigations must never mutate the versioned app-shell precache");
}
if (
  worker.indexOf("caches.match(OFFLINE_URL)") < 0 ||
  worker.indexOf("caches.match(OFFLINE_URL)") >
    worker.indexOf("caches.match(APP_SHELL_URL)")
) {
  fail("offline navigation must prefer the deterministic offline page");
}

const shellAssets = Array.from(
  indexHtml.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g),
  (match) => match[1],
);
for (const asset of shellAssets) {
  if (!worker.includes(JSON.stringify(asset))) {
    fail(`Service Worker does not precache app-shell asset ${asset}`);
  }
}

for (const relativePath of [
  "manifest.json",
  "offline.html",
  "offline-retry.js",
  "sw.js",
  "pwa-icon-192.png",
  "pwa-icon-512.png",
  "pwa-maskable-512.png",
  "apple-touch-icon.png",
]) {
  if (!statSync(resolve(dist, relativePath)).isFile()) {
    fail(`${relativePath} was not emitted`);
  }
}

console.log("PWA build verification passed");
