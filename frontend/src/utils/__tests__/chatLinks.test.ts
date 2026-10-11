import { describe, expect, it } from "vitest";
import {
  chatLinkDestinationHost,
  isDeceptiveChatLinkLabel,
  normalizeChatLinkInput,
  splitChatTextLinks,
} from "../chatLinks";

describe("chatLinks", () => {
  it("assumes https:// for addresses typed without a scheme", () => {
    expect(normalizeChatLinkInput(" www.example.com ")).toBe(
      "https://www.example.com",
    );
    expect(normalizeChatLinkInput("example.com/jobs")).toBe(
      "https://example.com/jobs",
    );
    expect(normalizeChatLinkInput("http://example.com")).toBe(
      "http://example.com",
    );
    expect(normalizeChatLinkInput("javascript:alert(1)")).toBe(
      "javascript:alert(1)",
    );
  });

  it("reports the destination host without www", () => {
    expect(chatLinkDestinationHost("https://www.Example.com/a")).toBe(
      "example.com",
    );
    expect(chatLinkDestinationHost("not a url")).toBeNull();
  });

  it("flags labels naming a different address", () => {
    const url = "https://evil.example.net/login";
    expect(isDeceptiveChatLinkLabel("google.com", url)).toBe(true);
    expect(isDeceptiveChatLinkLabel("Log in at www.paypal.com", url)).toBe(true);
    expect(isDeceptiveChatLinkLabel("Click here", url)).toBe(false);
    expect(isDeceptiveChatLinkLabel("example.net", url)).toBe(false);
    expect(isDeceptiveChatLinkLabel("My resume.pdf", url)).toBe(false);
    expect(isDeceptiveChatLinkLabel(url, url)).toBe(false);
  });

  it("links web addresses inside message text", () => {
    expect(
      splitChatTextLinks("See www.example.com/jobs, or (https://a.org/x)."),
    ).toEqual([
      { text: "See " },
      { text: "www.example.com/jobs", href: "https://www.example.com/jobs" },
      { text: ", or (" },
      { text: "https://a.org/x", href: "https://a.org/x" },
      { text: ")." },
    ]);
    expect(splitChatTextLinks("no links here")).toEqual([
      { text: "no links here" },
    ]);
    expect(splitChatTextLinks("javascript:alert(1)")).toEqual([
      { text: "javascript:alert(1)" },
    ]);
  });
});
