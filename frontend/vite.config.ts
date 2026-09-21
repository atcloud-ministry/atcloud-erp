//这个配置文件的作用是告诉 Vite：本项目使用 React，我希望在开发过程中使用 JSX 与快速刷新。它是 React 项目中非常基础和推荐的配置方式。

/// <reference types="vitest" />
import { defineConfig, loadEnv } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildContentSecurityPolicy } from "./src/config/contentSecurityPolicy";

// Read version from package.json
import packageJson from "./package.json";

function isSharedBuildHelper(id: string) {
  return id.includes("commonjsHelpers") || id.includes("vite/preload-helper");
}

function isGuardedFullstackLoopbackBuild(apiUrl: string): boolean {
  const backendValue = process.env.FULLSTACK_E2E_BACKEND_URL?.trim();
  const frontendValue = process.env.FULLSTACK_E2E_FRONTEND_URL?.trim();
  if (!backendValue || !frontendValue || !process.env.FULLSTACK_E2E_MONGODB_URI) {
    return false;
  }
  try {
    const api = new URL(apiUrl);
    const backend = new URL(backendValue);
    const frontend = new URL(frontendValue);
    return (
      api.origin === backend.origin &&
      (api.pathname === "/api" || api.pathname.startsWith("/api/")) &&
      backend.protocol === "http:" &&
      backend.hostname === "127.0.0.1" &&
      frontend.protocol === "http:" &&
      frontend.hostname === "127.0.0.1"
    );
  } catch {
    return false;
  }
}

const serviceWorkerTemplatePath = fileURLToPath(
  new URL("./pwa/service-worker.js", import.meta.url),
);

function pwaServiceWorkerPlugin(buildDiscriminator: string): Plugin {
  return {
    name: "build-versioned-pwa-service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      const shellFiles = new Set<string>();
      const pendingChunks = Object.values(bundle)
        .filter((output) => output.type === "chunk" && output.isEntry)
        .map((output) => output.fileName);

      while (pendingChunks.length > 0) {
        const fileName = pendingChunks.pop();
        if (!fileName || shellFiles.has(fileName)) continue;
        shellFiles.add(fileName);

        const output = bundle[fileName];
        if (output?.type === "chunk") {
          pendingChunks.push(...output.imports);
        }
      }

      for (const output of Object.values(bundle)) {
        if (output.fileName.endsWith(".css")) {
          shellFiles.add(output.fileName);
        }
      }

      const precacheUrls = [
        "/index.html",
        "/offline.html",
        "/offline-retry.js",
        "/manifest.json",
        "/Cloud-browsertag.png",
        "/pwa-icon-192.png",
        "/pwa-icon-512.png",
        "/pwa-maskable-512.png",
        "/apple-touch-icon.png",
        ...Array.from(shellFiles, (fileName) => `/${fileName}`),
      ].sort();

      const template = readFileSync(serviceWorkerTemplatePath, "utf8");
      const fingerprint = createHash("sha256")
        .update(packageJson.version)
        .update(buildDiscriminator)
        .update(template)
        .update(JSON.stringify(precacheUrls));
      for (const fileName of [
        "index.html",
        "manifest.json",
        "offline.html",
        "offline-retry.js",
        "Cloud-browsertag.png",
        "pwa-icon-192.png",
        "pwa-icon-512.png",
        "pwa-maskable-512.png",
        "apple-touch-icon.png",
      ]) {
        fingerprint.update(
          readFileSync(
            fileURLToPath(
              new URL(
                fileName === "index.html" ? `./${fileName}` : `./public/${fileName}`,
                import.meta.url,
              ),
            ),
          ),
        );
      }
      const serviceWorkerVersion = `${packageJson.version}-${fingerprint
        .digest("hex")
        .slice(0, 12)}`;
      const source = template
        .replace('"__PWA_VERSION__"', JSON.stringify(serviceWorkerVersion))
        .replace(
          "/* __PWA_PRECACHE_MANIFEST__ */ []",
          JSON.stringify(precacheUrls),
        );

      if (
        source.includes("__PWA_VERSION__") ||
        source.includes("__PWA_PRECACHE_MANIFEST__")
      ) {
        throw new Error("Unable to inject the PWA Service Worker build metadata");
      }

      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source,
      });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const allowExplicitLoopback =
    mode === "production" && isGuardedFullstackLoopbackBuild(env.VITE_API_URL);
  const contentSecurityPolicy = buildContentSecurityPolicy(
    env.VITE_API_URL,
    mode === "production",
    allowExplicitLoopback,
  );

  return {
    plugins: [
      react(),
      pwaServiceWorkerPlugin(contentSecurityPolicy),
      {
        name: "inject-content-security-policy",
        transformIndexHtml(html) {
          return html.replace(
            "__CONTENT_SECURITY_POLICY__",
            contentSecurityPolicy,
          );
        },
      },
      visualizer({
        filename: "dist/stats.html",
        open: false,
        gzipSize: true,
        brotliSize: true,
      }),
    ],
    // Inject app version as environment variable
    define: {
      __APP_VERSION__: JSON.stringify(packageJson.version),
    },
    // Build optimizations for production
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            // Keep shared build/runtime helpers out of feature chunks. If one lands
            // in a lazy vendor chunk, it can pull that entire feature into startup
            // or create an evaluation cycle before React's exports are ready.
            if (isSharedBuildHelper(id)) {
              return "vendor";
            }

            if (id.includes("node_modules")) {
              if (
                id.includes("/react/") ||
                id.includes("/react-dom/") ||
                id.includes("/react-router/") ||
                id.includes("/react-router-dom/") ||
                id.includes("/react-redux/") ||
                id.includes("/use-sync-external-store/") ||
                id.includes("scheduler")
              ) {
                return "react-vendor";
              }
              if (
                id.includes("react-hook-form") ||
                id.includes("@hookform/resolvers") ||
                id.includes("/yup/")
              ) {
                return "form-vendor";
              }
              if (id.includes("@heroicons/react")) {
                return "icons-vendor";
              }
              if (id.includes("recharts") || id.includes("d3-")) {
                return "charts-vendor";
              }
              if (
                id.includes("html2pdf.js") ||
                id.includes("html2canvas") ||
                id.includes("jspdf")
              ) {
                return "pdf-vendor";
              }
              if (id.includes("xlsx")) {
                return "spreadsheet-vendor";
              }
              if (
                id.includes("socket.io-client") ||
                id.includes("engine.io-client")
              ) {
                return "realtime-vendor";
              }
              if (id.includes("@stripe")) {
                return "payments-vendor";
              }
              return "vendor";
            }
          },
        },
      },
      // Increase chunk size warning limit (default is 500kb)
      chunkSizeWarningLimit: 1000,
      // Use default esbuild minifier (faster than terser)
      minify: "esbuild",
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      globals: true,
      css: true,
      coverage: {
        provider: "v8",
        reporter: ["text", "json", "html"],
        exclude: [
          "node_modules/",
          "src/test/",
          "**/*.test.{ts,tsx}",
          "**/*.spec.{ts,tsx}",
          "src/vite-env.d.ts",
        ],
        include: ["src/**/*.{ts,tsx}"],
      },
    },
    server: {
      port: 5173,
      host: true,
      proxy: {
        "/api": {
          target: "http://localhost:5001",
          changeOrigin: true,
          secure: false,
        },
        "/uploads": {
          target: "http://localhost:5001",
          changeOrigin: true,
          secure: false,
        },
        "^/s/[^/]+$": {
          target: "http://localhost:5001",
          changeOrigin: true,
          secure: false,
        },
      },
    },
  };
});
/*
CSP Policy Explanation:
- default-src 'self': Allow resources from same origin by default
- script-src 'unsafe-eval': Allow eval() for development tools
- script-src 'unsafe-inline': Allow inline scripts for React and Vite
- connect-src ws: wss:: Allow WebSocket connections for HMR
- This is safe for development but should be removed in production
*/
