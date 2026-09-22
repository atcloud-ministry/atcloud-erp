import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Reuse the backend's existing image dependency for this repository asset task.
const requireFromBackend = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const sharp = requireFromBackend("sharp");
const publicDirectory = resolve(fileURLToPath(new URL("../public/", import.meta.url)));
const officialLogo = resolve(publicDirectory, "Cloud-removebg.png");

async function createIcon(filename, size, logoWidthRatio) {
  const logo = await sharp(officialLogo)
    .resize({ width: Math.round(size * logoWidthRatio) })
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: "#ffffff",
    },
  })
    .composite([{ input: logo, gravity: "centre" }])
    .png()
    .toFile(resolve(publicDirectory, filename));
}

await createIcon("pwa-icon-192.png", 192, 0.9375);
await createIcon("pwa-icon-512.png", 512, 0.9375);
// Keep the artwork inside the adaptive-icon safe area on maskable platforms.
await createIcon("pwa-maskable-512.png", 512, 0.72);
