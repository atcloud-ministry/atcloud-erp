export const HTTP_BIND_HOST_ENV = "HTTP_BIND_HOST" as const;
export const FULLSTACK_E2E_BIND_HOST = "127.0.0.1" as const;

export class HttpBindingConfigurationError extends Error {
  readonly name = "HttpBindingConfigurationError";
  readonly code = "HTTP_BINDING_CONFIGURATION_INVALID";

  constructor() {
    super("HTTP server binding is not configured safely.");
  }
}

/**
 * Production keeps Node's platform-provided default binding. The full-stack
 * harness is required to opt into an explicit loopback-only listener.
 */
export function readHttpBindHost(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = environment[HTTP_BIND_HOST_ENV]?.trim();
  if (environment.NODE_ENV === "fullstack-e2e") {
    if (configured !== FULLSTACK_E2E_BIND_HOST) {
      throw new HttpBindingConfigurationError();
    }
    return FULLSTACK_E2E_BIND_HOST;
  }
  return configured || undefined;
}
