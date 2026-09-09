import { handleSessionExpired } from "../../session";
import type { ApiResponse, AuthTokens } from "./types";
import { sanitizeBaseURL, API_BASE_URL } from "./config";
import { socketService } from "../../socketService";

/**
 * Base API client with core request handling, authentication, and error management.
 * This class should be extended by domain-specific API modules.
 */
export class BaseApiClient {
  protected baseURL: string;

  constructor(baseURL: string = API_BASE_URL) {
    const normalized = sanitizeBaseURL(baseURL);
    this.baseURL = normalized;
  }

  /**
   * Core request method with automatic token refresh and error handling
   */
  protected async request<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<ApiResponse<T>> {
    const url = `${this.baseURL}${endpoint}`;

    // helper to construct headers and config with current token
    const buildConfig = (): RequestInit => {
      const token = localStorage.getItem("authToken");
      const defaultHeaders: HeadersInit = {};
      if (!(options.body instanceof FormData)) {
        defaultHeaders["Content-Type"] = "application/json";
      }
      if (token) {
        defaultHeaders.Authorization = `Bearer ${token}`;
      }
      return {
        ...options,
        headers: {
          ...defaultHeaders,
          ...options.headers,
        },
        credentials: "include",
      };
    };

    // Some bodies (FormData/streams) are one-shot; clone FormData for safe retry
    const cloneBodyIfNeeded = (body: BodyInit | null | undefined) => {
      if (body instanceof FormData) {
        const fd = new FormData();
        body.forEach((value, key) => {
          if (value instanceof Blob) {
            fd.append(key, value, (value as File).name);
          } else {
            fd.append(key, value as string);
          }
        });
        return fd as BodyInit;
      }
      return body;
    };

    // First attempt
    const config = buildConfig();
    // Track whether user had a token before this request.
    // If not, they are a guest — suppress session-expired modal on 401.
    const hadTokenBeforeRequest = !!localStorage.getItem("authToken");

    try {
      let response = await fetch(url, config);
      let data: ApiResponse<T>;
      try {
        data = (await response.json()) as ApiResponse<T>;
      } catch {
        // Non-JSON response
        data = {
          success: response.ok,
          message: response.statusText,
        } as ApiResponse<T>;
      }

      if (!response.ok) {
        // Attempt automatic refresh on 401 (skip for refresh endpoint itself)
        if (
          response.status === 401 &&
          !endpoint.includes("/auth/refresh-token")
        ) {
          try {
            await this.refreshToken();
            // rebuild config with new token and retry once
            const retryOptions: RequestInit = {
              ...options,
              body: cloneBodyIfNeeded(
                options.body as BodyInit | null | undefined,
              ),
            };
            const retryConfig: RequestInit = {
              ...retryOptions,
              headers: {
                ...(retryOptions.headers || {}),
              },
              credentials: "include",
            };
            // Merge auth headers freshly
            const token = localStorage.getItem("authToken");
            const hdrs: HeadersInit = {};
            if (!(retryOptions.body instanceof FormData)) {
              hdrs["Content-Type"] = "application/json";
            }
            if (token) hdrs.Authorization = `Bearer ${token}`;
            retryConfig.headers = { ...hdrs, ...(retryOptions.headers || {}) };

            response = await fetch(url, retryConfig);
            try {
              data = (await response.json()) as ApiResponse<T>;
            } catch {
              data = {
                success: response.ok,
                message: response.statusText,
              } as ApiResponse<T>;
            }

            if (response.ok) return data;
          } catch {
            // Refresh failed; clear token
            localStorage.removeItem("authToken");
            // Only show session-expired modal if user was previously authenticated.
            // Guests (no token before request) should get a silent rejection.
            if (hadTokenBeforeRequest) {
              handleSessionExpired();
            }
            return Promise.reject(
              new Error(
                hadTokenBeforeRequest
                  ? "Session expired"
                  : "Authentication required",
              ),
            );
          }
        }

        // For validation errors, include detailed error information
        if (
          response.status === 400 &&
          data?.errors &&
          Array.isArray(data.errors) &&
          data.errors.length > 0
        ) {
          const errorMessages = (data.errors as unknown[])
            .map((err: unknown) => {
              if (typeof err === "string") return err;
              if (
                err &&
                typeof err === "object" &&
                ("path" in err ||
                  "param" in err ||
                  "msg" in err ||
                  "message" in err)
              ) {
                const e = err as {
                  path?: string;
                  param?: string;
                  msg?: string;
                  message?: string;
                };
                const field = e.path || e.param || "";
                const message = e.msg || e.message || "invalid value";
                // Return just the message if it's descriptive, otherwise include field
                if (message.toLowerCase().includes(field.toLowerCase())) {
                  return message;
                }
                // Capitalize field name for display
                const displayField = field
                  .replace(/([A-Z])/g, " $1")
                  .replace(/^./, (s) => s.toUpperCase())
                  .trim();
                return displayField ? `${displayField}: ${message}` : message;
              }
              return "";
            })
            .filter(Boolean);

          // Format as newline-separated for better readability in modal
          const formattedErrors = errorMessages.join("\n");
          const err = new Error(
            formattedErrors || data.message || "Validation failed",
          ) as Error & {
            status?: number;
            validationErrors?: string[];
          };
          err.status = response.status;
          err.validationErrors = errorMessages;
          throw err;
        }

        const err = new Error(
          data?.message || `HTTP ${response.status}`,
        ) as Error & { status?: number };
        err.status = response.status;
        if (err.status === 401) {
          // Fallback path if we landed here without triggering above branch
          if (hadTokenBeforeRequest) {
            handleSessionExpired();
          }
          return Promise.reject(
            new Error(
              hadTokenBeforeRequest
                ? "Session expired"
                : "Authentication required",
            ),
          );
        }
        throw err;
      }

      return data;
    } catch (error) {
      console.error("API Request failed:", error);
      if (error instanceof Error) {
        return Promise.reject(error);
      }
      return Promise.reject(new Error("Network error"));
    }
  }

  /**
   * Refresh the authentication token
   * Protected so it can be overridden or exposed by subclasses
   */
  protected async refreshToken(): Promise<AuthTokens> {
    const url = `${this.baseURL}/auth/refresh-token`;
    const resp = await fetch(url, {
      method: "POST",
      credentials: "include",
    });
    const raw: unknown = await resp.json();
    const data = raw as Partial<ApiResponse<AuthTokens>> &
      Partial<AuthTokens> & {
        data?: Partial<AuthTokens>;
        message?: string;
      };
    if (!resp.ok) {
      throw new Error(data?.message || `HTTP ${resp.status}`);
    }
    const token = data.accessToken || data?.data?.accessToken;
    if (token) {
      localStorage.setItem("authToken", token);
      socketService.updateAuthenticationToken(token);
      const expiresAt =
        data.expiresAt ||
        data?.data?.expiresAt ||
        new Date(Date.now() + 55 * 60 * 1000).toISOString();
      return { accessToken: token, expiresAt };
    }
    throw new Error(data?.message || "Token refresh failed");
  }
}
