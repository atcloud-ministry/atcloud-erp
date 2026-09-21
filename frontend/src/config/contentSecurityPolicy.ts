import { DEFAULT_API_BASE_URL, getOriginFromURL } from "./apiUrl";

export const DEFAULT_BACKEND_ORIGINS = [
  "http://localhost:5001",
  "https://at-cloud-sign-up-system-backend.onrender.com",
  "https://atcloud-erp-backend-prod.onrender.com",
  "https://atcloud-erp-backend-staging.onrender.com",
];

function uniqueSources(sources: Array<string | null | undefined>): string[] {
  return Array.from(new Set(sources.filter(Boolean) as string[]));
}

function getWebSocketOrigins(origins: readonly string[]): string[] {
  return origins.flatMap((origin) => {
    try {
      const url = new URL(origin);
      if (url.protocol === "https:") return [`wss://${url.host}`];
      if (url.protocol === "http:") return [`ws://${url.host}`];
    } catch {
      // getBackendOrigins has already discarded invalid dynamic origins.
    }
    return [];
  });
}

export function getBackendOrigins(
  apiUrl: string = DEFAULT_API_BASE_URL,
): string[] {
  return uniqueSources([...DEFAULT_BACKEND_ORIGINS, getOriginFromURL(apiUrl)]);
}

export function getProductionBackendOrigins(
  apiUrl: string = DEFAULT_API_BASE_URL,
  allowExplicitLoopback = false,
): string[] {
  return getBackendOrigins(apiUrl).filter((origin) => {
    try {
      const url = new URL(origin);
      return (
        url.protocol === "https:" ||
        (allowExplicitLoopback &&
          url.protocol === "http:" &&
          url.hostname === "127.0.0.1")
      );
    } catch {
      return false;
    }
  });
}

export function buildContentSecurityPolicy(
  apiUrl: string = DEFAULT_API_BASE_URL,
  production = false,
  allowExplicitLoopback = false,
): string {
  const backendOrigins = production
    ? getProductionBackendOrigins(apiUrl, allowExplicitLoopback)
    : getBackendOrigins(apiUrl);
  const scriptSources = production
    ? ["script-src", "'self'"]
    : ["script-src", "'self'", "'unsafe-eval'", "'unsafe-inline'"];
  const connectSources = production
    ? [
        "connect-src",
        "'self'",
        ...backendOrigins,
        ...getWebSocketOrigins(backendOrigins),
      ]
    : ["connect-src", "'self'", "ws:", "wss:", ...backendOrigins];

  const directives = [
    ["default-src", "'self'"],
    scriptSources,
    ["style-src", "'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    [
      "img-src",
      "'self'",
      "data:",
      "blob:",
      ...backendOrigins,
      "https://i.ytimg.com",
      "https://*.ytimg.com",
    ],
    ["font-src", "'self'", "data:", "https://fonts.gstatic.com"],
    connectSources,
    ["media-src", "'self'"],
    ["worker-src", "'self'"],
    ["manifest-src", "'self'"],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
    ["frame-src", "'self'", "https://www.youtube.com", "https://youtube.com"],
  ];

  return `${directives.map((directive) => directive.join(" ")).join("; ")};`;
}
