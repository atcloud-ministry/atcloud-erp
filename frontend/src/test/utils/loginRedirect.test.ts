import { describe, expect, it } from "vitest";
import {
  buildLoginRedirectUrl,
  consumeStoredLoginRedirect,
  getPathWithSearch,
  getSafeLocationRedirectPath,
  isSafeInternalRedirectPath,
  resolvePostLoginRedirect,
} from "../../utils/loginRedirect";

describe("login redirect safety", () => {
  it("preserves an internal path, search, and fragment", () => {
    const target = getPathWithSearch({
      pathname: "/dashboard/chat-rooms/507f1f77bcf86cd799439011",
      search: "?source=push",
      hash: "#latest",
    });

    expect(target).toBe(
      "/dashboard/chat-rooms/507f1f77bcf86cd799439011?source=push#latest",
    );
    expect(isSafeInternalRedirectPath(target)).toBe(true);
    expect(getSafeLocationRedirectPath({ pathname: target })).toBe(target);
  });

  it.each([
    "https://evil.example/path",
    "//evil.example/path",
    "/\\evil.example/path",
    "/dashboard/chat-rooms/id\nmalformed",
    "dashboard/chat-rooms/id",
  ])("rejects unsafe return target %s", (target) => {
    expect(isSafeInternalRedirectPath(target)).toBe(false);
    expect(buildLoginRedirectUrl(target)).toBe("/login");
  });

  it("consumes stored destinations once and discards unsafe values", () => {
    const entries = new Map<string, string>([
      ["returnUrl", "/dashboard/community/help-requests/request#outcome"],
    ]);
    const storage = {
      getItem: (key: string) => entries.get(key) ?? null,
      removeItem: (key: string) => entries.delete(key),
    };

    expect(consumeStoredLoginRedirect(storage)).toBe(
      "/dashboard/community/help-requests/request#outcome",
    );
    expect(consumeStoredLoginRedirect(storage)).toBeNull();

    entries.set("returnUrl", "//evil.example");
    expect(consumeStoredLoginRedirect(storage)).toBeNull();
    expect(entries.has("returnUrl")).toBe(false);
  });

  it("uses one deterministic priority for all post-login recovery", () => {
    expect(
      resolvePostLoginRedirect({
        search:
          "?redirect=%2Fdashboard%2Fchat-rooms%2F507f1f77bcf86cd799439011%23latest",
        from: {
          pathname: "/dashboard/community/help-requests/request",
        },
        storedReturnUrl: "/dashboard/donate",
      }),
    ).toBe("/dashboard/chat-rooms/507f1f77bcf86cd799439011#latest");

    expect(
      resolvePostLoginRedirect({
        search: "?redirect=//evil.example",
        from: {
          pathname: "/dashboard/community/help-requests/request",
          search: "?source=push",
          hash: "#outcome",
        },
        storedReturnUrl: "/dashboard/donate",
      }),
    ).toBe(
      "/dashboard/community/help-requests/request?source=push#outcome",
    );
  });
});
