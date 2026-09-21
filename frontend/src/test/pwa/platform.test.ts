import { describe, expect, it } from "vitest";
import {
  isAppleMobilePlatform,
  isStandaloneDisplay,
  shouldOfferAppleHomeScreenInstall,
} from "../../pwa/platform";

describe("PWA platform detection", () => {
  it("detects iPhone and iPad user agents", () => {
    expect(
      isAppleMobilePlatform({
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15",
      }),
    ).toBe(true);
    expect(
      isAppleMobilePlatform({
        userAgent:
          "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15",
      }),
    ).toBe(true);
  });

  it("detects iPadOS desktop-mode user agents without classifying a Mac", () => {
    expect(
      isAppleMobilePlatform({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        platform: "MacIntel",
        maxTouchPoints: 5,
      }),
    ).toBe(true);
    expect(
      isAppleMobilePlatform({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)",
        platform: "MacIntel",
        maxTouchPoints: 0,
      }),
    ).toBe(false);
  });

  it("detects standalone mode from either Apple or standard browser APIs", () => {
    expect(
      isStandaloneDisplay({ userAgent: "test", standalone: true }, null),
    ).toBe(true);
    expect(
      isStandaloneDisplay({ userAgent: "test" }, { matches: true }),
    ).toBe(true);
    expect(
      isStandaloneDisplay({ userAgent: "test" }, { matches: false }),
    ).toBe(false);
  });

  it("offers Home Screen instructions only on non-standalone Apple mobile devices", () => {
    const iphone = {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)",
    };
    expect(
      shouldOfferAppleHomeScreenInstall(iphone, { matches: false }),
    ).toBe(true);
    expect(
      shouldOfferAppleHomeScreenInstall(
        { ...iphone, standalone: true },
        { matches: false },
      ),
    ).toBe(false);
  });
});
