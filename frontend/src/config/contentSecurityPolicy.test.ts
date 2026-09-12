import { describe, expect, it } from "vitest";
import {
  buildContentSecurityPolicy,
  DEFAULT_BACKEND_ORIGINS,
  getBackendOrigins,
  getProductionBackendOrigins,
} from "./contentSecurityPolicy";

describe("content security policy", () => {
  it("allows the configured API origin for fetches and images", () => {
    const policy = buildContentSecurityPolicy("https://api.example.com/api");

    expect(policy).toContain("connect-src");
    expect(policy).toContain("img-src");
    expect(policy).toContain("https://api.example.com");
    expect(policy).not.toContain("https://api.example.com/api");
  });

  it("keeps known Render backend origins in the allow-list", () => {
    const origins = getBackendOrigins("https://api.example.com/api");

    DEFAULT_BACKEND_ORIGINS.forEach((origin) => {
      expect(origins).toContain(origin);
    });
  });

  it("keeps localhost and insecure dynamic origins out of production", () => {
    const origins = getProductionBackendOrigins(
      "http://localhost:9123/api",
    );

    expect(origins).not.toContain("http://localhost:5001");
    expect(origins).not.toContain("http://localhost:9123");
    expect(origins).toContain(
      "https://atcloud-erp-backend-prod.onrender.com",
    );
    expect(getProductionBackendOrigins("https://api.example.com/api")).toContain(
      "https://api.example.com",
    );
  });

  it("admits only an explicit numeric loopback API for the guarded full-stack build", () => {
    expect(
      getProductionBackendOrigins(
        "http://127.0.0.1:9123/api",
        true,
      ),
    ).toContain("http://127.0.0.1:9123");
    expect(
      getProductionBackendOrigins("http://localhost:9123/api", true),
    ).not.toContain("http://localhost:9123");

    const policy = buildContentSecurityPolicy(
      "http://127.0.0.1:9123/api",
      true,
      true,
    );
    expect(policy).toContain("http://127.0.0.1:9123");
    expect(policy).toContain("ws://127.0.0.1:9123");
  });

  it("allows only same-origin workers and manifests", () => {
    const policy = buildContentSecurityPolicy("https://api.example.com/api");

    expect(policy).toContain("worker-src 'self'");
    expect(policy).toContain("manifest-src 'self'");
  });

  it("removes development-only script execution allowances in production", () => {
    const productionPolicy = buildContentSecurityPolicy(
      "https://api.example.com/api",
      true,
    );
    const developmentPolicy = buildContentSecurityPolicy(
      "https://api.example.com/api",
      false,
    );

    expect(productionPolicy).toContain("script-src 'self';");
    expect(productionPolicy).not.toContain("'unsafe-eval'");
    expect(productionPolicy).not.toMatch(
      /script-src[^;]*'unsafe-inline'/u,
    );
    expect(developmentPolicy).toContain("'unsafe-eval'");
    expect(developmentPolicy).toMatch(/script-src[^;]*'unsafe-inline'/u);
    expect(productionPolicy).toContain(
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    );
  });

  it("limits production WebSockets to approved backend origins", () => {
    const productionPolicy = buildContentSecurityPolicy(
      "https://api.example.com/api",
      true,
    );
    const connectDirective = productionPolicy
      .split("; ")
      .find((directive) => directive.startsWith("connect-src"));

    expect(connectDirective?.split(" ")).not.toContain("ws:");
    expect(connectDirective?.split(" ")).not.toContain("wss:");
    expect(connectDirective).toContain("wss://api.example.com");
    expect(connectDirective).toContain(
      "wss://atcloud-erp-backend-prod.onrender.com",
    );
    expect(connectDirective).not.toContain("ws://localhost:5001");
    expect(productionPolicy).not.toContain("http://localhost:5001");
  });
});
