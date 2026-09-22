import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import {
  ALUMNI_CONTACT_LOOKUP_KEY_ENV,
  ALUMNI_INVITATION_TOKEN_KEY_ENV,
  AlumniInvitationSecurityConfigurationError,
  assertAlumniInvitationSecurityConfiguration,
  readAlumniContactLookupKey,
} from "../../../../src/config/alumniInvitationSecurity";
import {
  ALUMNI_INVITATION_TOKEN_PATTERN,
  alumniInvitationTokenHashMatches,
  deriveAlumniContactLookupHash,
  deriveAlumniInvitationToken,
  hashAlumniInvitationToken,
  normalizeAlumniContactEmail,
  type AlumniInvitationSecurityKeyReaders,
} from "../../../../src/services/alumni/AlumniInvitationSecurity";

const CONTACT_KEY = Buffer.alloc(32, 0x11);
const TOKEN_KEY = Buffer.alloc(32, 0x22);
const KEY_READERS: AlumniInvitationSecurityKeyReaders = Object.freeze({
  readContactLookupKey: () => Buffer.from(CONTACT_KEY),
  readInvitationTokenKey: () => Buffer.from(TOKEN_KEY),
});

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    [ALUMNI_CONTACT_LOOKUP_KEY_ENV]: CONTACT_KEY.toString("base64url"),
    [ALUMNI_INVITATION_TOKEN_KEY_ENV]: TOKEN_KEY.toString("base64url"),
  };
}

describe("alumni invitation secret configuration", () => {
  it("accepts two independent canonical 256-bit base64url keys", () => {
    const environment = validEnvironment();
    expect(() =>
      assertAlumniInvitationSecurityConfiguration(environment),
    ).not.toThrow();
    expect(readAlumniContactLookupKey(1, environment)).toEqual(CONTACT_KEY);
  });

  it.each([
    ["missing", undefined],
    ["too short", "a".repeat(42)],
    ["padded", `${CONTACT_KEY.toString("base64url")}=`],
    ["whitespace", ` ${CONTACT_KEY.toString("base64url")}`],
  ])("rejects %s keys without a development fallback", (_label, value) => {
    const environment = validEnvironment();
    if (value === undefined) delete environment[ALUMNI_CONTACT_LOOKUP_KEY_ENV];
    else environment[ALUMNI_CONTACT_LOOKUP_KEY_ENV] = value;
    environment.NODE_ENV = "development";

    expect(() =>
      assertAlumniInvitationSecurityConfiguration(environment),
    ).toThrow(AlumniInvitationSecurityConfigurationError);
  });

  it("rejects key reuse without exposing either key", () => {
    const environment = validEnvironment();
    environment[ALUMNI_INVITATION_TOKEN_KEY_ENV] =
      environment[ALUMNI_CONTACT_LOOKUP_KEY_ENV];
    let observed: Error | undefined;
    try {
      assertAlumniInvitationSecurityConfiguration(environment);
    } catch (error) {
      observed = error as Error;
    }
    expect(observed).toBeInstanceOf(
      AlumniInvitationSecurityConfigurationError,
    );
    expect(observed?.message).not.toContain(CONTACT_KEY.toString("base64url"));
  });
});

describe("alumni invitation cryptography", () => {
  it("normalizes email exactly like the persisted User email", () => {
    expect(normalizeAlumniContactEmail("  Alumna@Example.COM ")).toBe(
      "alumna@example.com",
    );
    expect(() => normalizeAlumniContactEmail("bad\n@example.com")).toThrow();
  });

  it("uses a stable keyed contact digest rather than a plain email hash", () => {
    const first = deriveAlumniContactLookupHash(
      " Alumna@Example.COM ",
      1,
      KEY_READERS,
    );
    const second = deriveAlumniContactLookupHash(
      "alumna@example.com",
      1,
      KEY_READERS,
    );
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(
      createHash("sha256").update("alumna@example.com").digest("hex"),
    );
  });

  it("derives a fixed-length token that changes for every issuance", () => {
    const material = {
      invitationId: "64f100000000000000000001",
      issueCount: 1,
      issuedAt: new Date("2026-09-12T00:00:00.000Z"),
    };
    const first = deriveAlumniInvitationToken(material, KEY_READERS);
    const replay = deriveAlumniInvitationToken(material, KEY_READERS);
    const reissued = deriveAlumniInvitationToken(
      { ...material, issueCount: 2 },
      KEY_READERS,
    );

    expect(first).toBe(replay);
    expect(first).toMatch(ALUMNI_INVITATION_TOKEN_PATTERN);
    expect(first).toHaveLength(43);
    expect(reissued).not.toBe(first);
  });

  it("persists only a domain-separated hash and compares it safely", () => {
    const token = deriveAlumniInvitationToken(
      {
        invitationId: "64f100000000000000000001",
        issueCount: 1,
        issuedAt: new Date("2026-09-12T00:00:00.000Z"),
        tokenVersion: 1,
      },
      KEY_READERS,
    );
    const tokenHash = hashAlumniInvitationToken(token);
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenHash).not.toContain(token);
    expect(alumniInvitationTokenHashMatches(token, tokenHash)).toBe(true);
    const replacement = token.endsWith("A") ? "B" : "A";
    expect(
      alumniInvitationTokenHashMatches(
        `${token.slice(0, -1)}${replacement}`,
        tokenHash,
      ),
    ).toBe(false);
    expect(alumniInvitationTokenHashMatches(token, "not-a-hash")).toBe(false);
  });
});
