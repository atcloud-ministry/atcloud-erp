import { createServer, request as httpRequest, type Server } from "node:http";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import app from "../../../src/app";

const ROOM_ID = "507f191e810c19729de860ea";
const PATH = `/api/conversations/${ROOM_ID}/messages`;
const CLIENT_MESSAGE_ID = "3f00aa31-36f0-4f05-8f4a-a362bf33a111";

function paddedBody(): string {
  return `${" ".repeat(16 * 1_024)}${JSON.stringify({
    clientMessageId: CLIENT_MESSAGE_ID,
    content: "Hello",
  })}`;
}

let server: Server | null = null;

afterEach(async () => {
  if (!server) return;
  const active = server;
  server = null;
  await new Promise<void>((resolve) => active.close(() => resolve()));
});

describe("chat message raw HTTP size boundary", () => {
  it("rejects a whitespace-padded JSON body before authentication", async () => {
    const response = await request(app)
      .post(PATH)
      .set("Content-Type", "application/json")
      .send(paddedBody())
      .expect(413);

    expect(response.body).toEqual({
      success: false,
      code: "CHAT_MESSAGE_PAYLOAD_TOO_LARGE",
      message: "The chat message payload exceeds 16 KiB.",
    });
  });

  it.each(["text/plain", "application/x-www-form-urlencoded"])(
    "cannot bypass the raw boundary with forged %s content",
    async (contentType) => {
      const response = await request(app)
        .post(PATH)
        .set("Content-Type", contentType)
        .send(paddedBody())
        .expect(413);

      expect(response.body).toMatchObject({
        success: false,
        code: "CHAT_MESSAGE_PAYLOAD_TOO_LARGE",
      });
    },
  );

  it("enforces the same boundary for a chunked request", async () => {
    server = createServer(app);
    await new Promise<void>((resolve) => {
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test HTTP server did not bind a TCP port.");
    }
    const body = paddedBody();
    const response = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const outgoing = httpRequest(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path: PATH,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Transfer-Encoding": "chunked",
            },
          },
          (incoming) => {
            let data = "";
            incoming.setEncoding("utf8");
            incoming.on("data", (chunk) => {
              data += chunk;
            });
            incoming.on("end", () => {
              resolve({ status: incoming.statusCode ?? 0, body: data });
            });
          },
        );
        outgoing.on("error", reject);
        const midpoint = Math.floor(body.length / 2);
        outgoing.write(body.slice(0, midpoint));
        outgoing.end(body.slice(midpoint));
      },
    );

    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toMatchObject({
      code: "CHAT_MESSAGE_PAYLOAD_TOO_LARGE",
    });
  });
});
