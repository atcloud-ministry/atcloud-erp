import { describe, expect, it } from "vitest";
import {
  FULLSTACK_E2E_BIND_HOST,
  HttpBindingConfigurationError,
  readHttpBindHost,
} from "../../../src/config/httpBinding";

describe("HTTP binding configuration", () => {
  it("requires an explicit loopback listener for full-stack E2E", () => {
    expect(
      readHttpBindHost({
        NODE_ENV: "fullstack-e2e",
        HTTP_BIND_HOST: FULLSTACK_E2E_BIND_HOST,
      }),
    ).toBe("127.0.0.1");

    expect(() =>
      readHttpBindHost({ NODE_ENV: "fullstack-e2e" }),
    ).toThrow(HttpBindingConfigurationError);
    expect(() =>
      readHttpBindHost({
        NODE_ENV: "fullstack-e2e",
        HTTP_BIND_HOST: "0.0.0.0",
      }),
    ).toThrow(HttpBindingConfigurationError);
  });

  it("preserves the platform default unless another environment opts in", () => {
    expect(readHttpBindHost({ NODE_ENV: "production" })).toBeUndefined();
    expect(
      readHttpBindHost({
        NODE_ENV: "development",
        HTTP_BIND_HOST: "localhost",
      }),
    ).toBe("localhost");
  });
});
