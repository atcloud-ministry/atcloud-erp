import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CHAT_HISTORY_PAGE_DEFAULT,
  CHAT_ROOM_PAGE_DEFAULT,
  ChatRoomFlowValidationError,
  ChatRoomPayloadTooLargeError,
  parseChatMessageHistoryQuery,
  parseChatRoomListQuery,
  parseMuteChatRoomBody,
  parseReadChatRoomBody,
  parseSendChatMessageBody,
} from "../../../src/contracts/chatRoomFlow";

describe("chat room HTTP contract parsing", () => {
  it("applies approved room and history defaults", () => {
    expect(parseChatRoomListQuery({})).toEqual({
      view: "current",
      page: 1,
      limit: CHAT_ROOM_PAGE_DEFAULT,
    });
    expect(parseChatMessageHistoryQuery({})).toEqual({
      limit: CHAT_HISTORY_PAGE_DEFAULT,
    });
  });

  it("parses page and directional recovery queries", () => {
    expect(parseChatRoomListQuery({ view: "past", page: "2", limit: "100" }))
      .toEqual({ view: "past", page: 2, limit: 100 });
    expect(parseChatMessageHistoryQuery({ afterSequence: "0", limit: "25" }))
      .toEqual({ afterSequence: 0, limit: 25 });
    expect(parseChatMessageHistoryQuery({ beforeSequence: "91" }))
      .toEqual({ beforeSequence: 91, limit: CHAT_HISTORY_PAGE_DEFAULT });
  });

  it("rejects ambiguous cursors, arrays, unknown fields, and unsafe pages", () => {
    for (const value of [
      { beforeSequence: "2", afterSequence: "1" },
      { limit: ["5"] },
      { cursor: "opaque" },
      { page: "0" },
      { limit: "101" },
    ]) {
      expect(() =>
        "page" in value || "cursor" in value
          ? parseChatRoomListQuery(value)
          : parseChatMessageHistoryQuery(value),
      ).toThrow(ChatRoomFlowValidationError);
    }
  });

  it("normalizes plain text and canonical HTTP(S) safe links", () => {
    const clientMessageId = randomUUID().toUpperCase();
    expect(
      parseSendChatMessageBody({
        clientMessageId,
        content: "  cafe\u0301\r\nnext  ",
        safeLink: { url: "https://example.org/jobs", label: "  Open   role " },
      }),
    ).toEqual({
      clientMessageId: clientMessageId.toLowerCase(),
      content: "café\nnext",
      safeLink: { url: "https://example.org/jobs", label: "Open role" },
    });
  });

  it("accepts content-only and link-only messages", () => {
    expect(
      parseSendChatMessageBody({
        clientMessageId: randomUUID(),
        content: "Hello",
      }).safeLink,
    ).toBeNull();
    expect(
      parseSendChatMessageBody({
        clientMessageId: randomUUID(),
        safeLink: { url: "http://example.org", label: "Example" },
      }).content,
    ).toBeNull();
  });

  it("rejects executable/credential links and unsafe control characters", () => {
    for (const body of [
      {
        clientMessageId: randomUUID(),
        safeLink: { url: "javascript:alert(1)", label: "bad" },
      },
      {
        clientMessageId: randomUUID(),
        safeLink: { url: "https://user:secret@example.org", label: "bad" },
      },
      { clientMessageId: randomUUID(), content: "bad\u0000text" },
      { clientMessageId: randomUUID(), content: "   " },
    ]) {
      expect(() => parseSendChatMessageBody(body)).toThrow(
        ChatRoomFlowValidationError,
      );
    }
  });

  it("enforces the complete UTF-8 HTTP payload at 16 KiB", () => {
    expect(() =>
      parseSendChatMessageBody({
        clientMessageId: randomUUID(),
        content: "😀".repeat(4_000),
        safeLink: {
          url: `https://example.org/${"a".repeat(500)}`,
          label: "Reference",
        },
      }),
    ).toThrow(ChatRoomPayloadTooLargeError);
  });

  it("strictly parses read and mute mutations", () => {
    expect(parseReadChatRoomBody({ throughSequence: 0 })).toEqual({
      throughSequence: 0,
    });
    expect(parseMuteChatRoomBody({ muted: true })).toEqual({ muted: true });
    expect(() => parseReadChatRoomBody({ throughSequence: -1 })).toThrow(
      ChatRoomFlowValidationError,
    );
    expect(() => parseMuteChatRoomBody({ muted: "true" })).toThrow(
      ChatRoomFlowValidationError,
    );
  });
});
