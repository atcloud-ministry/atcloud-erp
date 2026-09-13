import { describe, expect, it } from "vitest";
import {
  CHAT_HTTP_PAYLOAD_MAX_BYTES,
  ChatRoomFlowValidationError,
  ChatRoomPayloadTooLargeError,
} from "../../../src/contracts/chatRoomFlow";
import { parsePublishProgramAnnouncementBody } from "../../../src/contracts/programAnnouncements";

const CLIENT_MESSAGE_ID = "3f00aa31-36f0-4f05-8f4a-a362bf33a111";

describe("Program announcement contract", () => {
  it("normalizes an exact strict request", () => {
    expect(
      parsePublishProgramAnnouncementBody({
        clientMessageId: CLIENT_MESSAGE_ID.toUpperCase(),
        content: "  Program update\r\nNext step  ",
      }),
    ).toEqual({
      clientMessageId: CLIENT_MESSAGE_ID,
      content: "Program update\nNext step",
    });
  });

  it("rejects unknown/accessor fields, invalid IDs, and unsafe or empty content", () => {
    expect(() =>
      parsePublishProgramAnnouncementBody({
        clientMessageId: CLIENT_MESSAGE_ID,
        content: "Update",
        safeLink: null,
      }),
    ).toThrow(ChatRoomFlowValidationError);
    const accessor = Object.defineProperty(
      { clientMessageId: CLIENT_MESSAGE_ID },
      "content",
      { enumerable: true, get: () => "Update" },
    );
    expect(() => parsePublishProgramAnnouncementBody(accessor)).toThrow(
      ChatRoomFlowValidationError,
    );
    expect(() =>
      parsePublishProgramAnnouncementBody({
        clientMessageId: "not-a-uuid",
        content: "Update",
      }),
    ).toThrow(ChatRoomFlowValidationError);
    expect(() =>
      parsePublishProgramAnnouncementBody({
        clientMessageId: CLIENT_MESSAGE_ID,
        content: " \u0000 ",
      }),
    ).toThrow(ChatRoomFlowValidationError);
  });

  it("enforces 4,000 Unicode code points and a 16 KiB normalized envelope", () => {
    const accepted = parsePublishProgramAnnouncementBody({
      clientMessageId: CLIENT_MESSAGE_ID,
      content: "😀".repeat(4_000),
    });
    expect(Array.from(accepted.content)).toHaveLength(4_000);
    expect(() =>
      parsePublishProgramAnnouncementBody({
        clientMessageId: CLIENT_MESSAGE_ID,
        content: "😀".repeat(4_001),
      }),
    ).toThrow(ChatRoomFlowValidationError);
    expect(() =>
      parsePublishProgramAnnouncementBody({
        clientMessageId: CLIENT_MESSAGE_ID,
        content: "a".repeat(CHAT_HTTP_PAYLOAD_MAX_BYTES),
      }),
    ).toThrow(ChatRoomPayloadTooLargeError);
  });
});
