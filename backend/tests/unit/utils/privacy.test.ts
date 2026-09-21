/**
 * Privacy Utilities Unit Tests
 *
 * Tests privacy-focused utility functions:
 * - hashEmail: SHA256 hashing with normalization
 * - truncateIpToCidr: IP anonymization for privacy
 * - stripContactInfo: Remove sensitive contact fields from user objects
 * - sanitizeMentor/sanitizeMentors: Conditionally strip mentor contact info
 * - sanitizeParticipant/sanitizeParticipants: Conditionally strip participant contact info
 */

import { describe, it, expect } from "vitest";
import {
  hashEmail,
  truncateIpToCidr,
  stripContactInfo,
  sanitizeMentor,
  sanitizeMentors,
  sanitizeParticipant,
  sanitizeParticipants,
  canViewExactPrivateProfileFields,
  stripExactPrivateProfileFields,
} from "../../../src/utils/privacy";
import crypto from "crypto";

describe("privacy utilities", () => {
  describe("hashEmail", () => {
    it("should hash email with SHA256", () => {
      const email = "test@example.com";
      const expected = crypto
        .createHash("sha256")
        .update("test@example.com")
        .digest("hex");

      const result = hashEmail(email);

      expect(result).toBe(expected);
    });

    it("should lowercase email before hashing", () => {
      const uppercase = "TEST@EXAMPLE.COM";
      const lowercase = "test@example.com";

      const resultUpper = hashEmail(uppercase);
      const resultLower = hashEmail(lowercase);

      expect(resultUpper).toBe(resultLower);
    });

    it("should trim whitespace before hashing", () => {
      const withWhitespace = "  test@example.com  ";
      const trimmed = "test@example.com";

      const resultWhitespace = hashEmail(withWhitespace);
      const resultTrimmed = hashEmail(trimmed);

      expect(resultWhitespace).toBe(resultTrimmed);
    });

    it("should handle mixed case and whitespace", () => {
      const messy = "  TEST@EXAMPLE.COM  ";
      const clean = "test@example.com";

      const resultMessy = hashEmail(messy);
      const resultClean = hashEmail(clean);

      expect(resultMessy).toBe(resultClean);
    });

    it("should produce consistent hashes", () => {
      const email = "user@domain.org";

      const hash1 = hashEmail(email);
      const hash2 = hashEmail(email);

      expect(hash1).toBe(hash2);
    });

    it("should produce different hashes for different emails", () => {
      const email1 = "user1@example.com";
      const email2 = "user2@example.com";

      const hash1 = hashEmail(email1);
      const hash2 = hashEmail(email2);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("truncateIpToCidr", () => {
    describe("IPv4 addresses", () => {
      it("should truncate IPv4 to /24 CIDR", () => {
        const result = truncateIpToCidr("192.168.1.100");

        expect(result).toBe("192.168.1.0/24");
      });

      it("should handle different IPv4 addresses", () => {
        expect(truncateIpToCidr("10.0.0.1")).toBe("10.0.0.0/24");
        expect(truncateIpToCidr("172.16.255.200")).toBe("172.16.255.0/24");
        expect(truncateIpToCidr("8.8.8.8")).toBe("8.8.8.0/24");
      });

      it("should extract IPv4 from longer strings (e.g., proxied IPs)", () => {
        const result = truncateIpToCidr("::ffff:192.168.1.50");

        expect(result).toBe("192.168.1.0/24");
      });
    });

    describe("IPv6 addresses", () => {
      it("should truncate IPv6 to /48 CIDR (first 3 hextets)", () => {
        const result = truncateIpToCidr(
          "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
        );

        expect(result).toBe("2001:0db8:85a3::/48");
      });

      it("should handle compressed IPv6 addresses", () => {
        const result = truncateIpToCidr("2001:db8:85a3::1");

        expect(result).toBe("2001:db8:85a3::/48");
      });

      it("should handle IPv6 with zone identifier", () => {
        // "fe80::1%eth0" after removing zone becomes "fe80::1"
        // When split by ":" and filtered for non-empty, only gives ["fe80", "1"]
        // This is less than 3 hextets, so returns null
        const result = truncateIpToCidr("fe80::1%eth0");

        expect(result).toBeNull();
      });

      it("should handle full IPv6 with zone identifier", () => {
        // Full IPv6 with zone: after cleanup has enough hextets
        const result = truncateIpToCidr("2001:db8:85a3::1%eth0");

        expect(result).toBe("2001:db8:85a3::/48");
      });
    });

    describe("edge cases", () => {
      it("should return null for undefined", () => {
        const result = truncateIpToCidr(undefined);

        expect(result).toBeNull();
      });

      it("should return null for null", () => {
        const result = truncateIpToCidr(null);

        expect(result).toBeNull();
      });

      it("should return null for empty string", () => {
        const result = truncateIpToCidr("");

        expect(result).toBeNull();
      });

      it("should return null for invalid IP format", () => {
        expect(truncateIpToCidr("not-an-ip")).toBeNull();
        expect(truncateIpToCidr("abc.def.ghi.jkl")).toBeNull();
      });

      it("should return null for partial IPv4", () => {
        expect(truncateIpToCidr("192.168")).toBeNull();
        expect(truncateIpToCidr("192.168.1")).toBeNull();
      });

      it("should return null for IPv6 with less than 3 hextets", () => {
        expect(truncateIpToCidr("2001:db8")).toBeNull();
      });

      it("should handle localhost IPv4", () => {
        const result = truncateIpToCidr("127.0.0.1");

        expect(result).toBe("127.0.0.0/24");
      });

      it("should handle 'unknown' string", () => {
        const result = truncateIpToCidr("unknown");

        expect(result).toBeNull();
      });
    });
  });

  describe("stripContactInfo", () => {
    it("should remove email and phone from user object", () => {
      const user = {
        firstName: "John",
        lastName: "Doe",
        email: "john@example.com",
        phone: "555-1234",
        avatar: "/avatar.jpg",
      };

      const result = stripContactInfo(user);

      expect(result).toEqual({
        firstName: "John",
        lastName: "Doe",
        avatar: "/avatar.jpg",
      });
      expect(result).not.toHaveProperty("email");
      expect(result).not.toHaveProperty("phone");
    });

    it("should handle user with only email", () => {
      const user = {
        firstName: "John",
        email: "john@example.com",
      };

      const result = stripContactInfo(user);

      expect(result).toEqual({ firstName: "John" });
      expect(result).not.toHaveProperty("email");
    });

    it("should handle user with only phone", () => {
      const user = {
        firstName: "John",
        phone: "555-1234",
      };

      const result = stripContactInfo(user);

      expect(result).toEqual({ firstName: "John" });
      expect(result).not.toHaveProperty("phone");
    });

    it("should return same object structure without contact fields", () => {
      const user = {
        _id: "123",
        firstName: "John",
        lastName: "Doe",
        email: "john@example.com",
        phone: "555-1234",
        avatar: "/avatar.jpg",
        gender: "male" as const,
        roleInAtCloud: "Mentor",
      };

      const result = stripContactInfo(user);

      expect(result).toEqual({
        _id: "123",
        firstName: "John",
        lastName: "Doe",
        avatar: "/avatar.jpg",
        gender: "male",
        roleInAtCloud: "Mentor",
      });
    });
  });

  describe("sanitizeMentor", () => {
    const mentor = {
      userId: "123",
      firstName: "Jane",
      lastName: "Smith",
      email: "jane@example.com",
      avatar: "/jane.jpg",
    };

    it("should return full mentor when canViewContact is true", () => {
      const result = sanitizeMentor(mentor, true);

      expect(result).toEqual(mentor);
      expect((result as typeof mentor).email).toBe("jane@example.com");
    });

    it("should strip contact info when canViewContact is false", () => {
      const result = sanitizeMentor(mentor, false);

      expect(result).not.toHaveProperty("email");
      expect(result).toHaveProperty("firstName", "Jane");
      expect(result).toHaveProperty("lastName", "Smith");
    });
  });

  describe("sanitizeMentors", () => {
    const mentors = [
      { userId: "1", firstName: "John", email: "john@example.com" },
      {
        userId: "2",
        firstName: "Jane",
        email: "jane@example.com",
        phone: "555-1234",
      },
    ];

    it("should return all mentors with contact info when canViewContact is true", () => {
      const result = sanitizeMentors(mentors, true);

      expect(result).toHaveLength(2);
      expect((result[0] as (typeof mentors)[0]).email).toBe("john@example.com");
      expect((result[1] as (typeof mentors)[1]).email).toBe("jane@example.com");
      expect((result[1] as (typeof mentors)[1]).phone).toBe("555-1234");
    });

    it("should strip contact info from all mentors when canViewContact is false", () => {
      const result = sanitizeMentors(mentors, false);

      expect(result).toHaveLength(2);
      expect(result[0]).not.toHaveProperty("email");
      expect(result[1]).not.toHaveProperty("email");
      expect(result[1]).not.toHaveProperty("phone");
      expect(result[0].firstName).toBe("John");
      expect(result[1].firstName).toBe("Jane");
    });

    it("should handle empty array", () => {
      const result = sanitizeMentors([], false);

      expect(result).toEqual([]);
    });
  });

  describe("sanitizeParticipant", () => {
    const participant = {
      user: {
        firstName: "Bob",
        lastName: "Wilson",
        email: "bob@example.com",
        phone: "555-9999",
        avatar: "/bob.jpg",
      },
      isPaid: true,
      enrollmentDate: new Date("2024-01-01"),
    };

    it("should return full participant when canViewContact is true", () => {
      const result = sanitizeParticipant(participant, true);

      expect(result.user.email).toBe("bob@example.com");
      expect(result.user.phone).toBe("555-9999");
      expect(result.isPaid).toBe(true);
    });

    it("should strip contact info from nested user when canViewContact is false", () => {
      const result = sanitizeParticipant(participant, false);

      expect(result.user).not.toHaveProperty("email");
      expect(result.user).not.toHaveProperty("phone");
      expect(result.user.firstName).toBe("Bob");
      expect(result.isPaid).toBe(true);
    });
  });

  describe("sanitizeParticipants", () => {
    const participants = [
      {
        user: { firstName: "Alice", email: "alice@example.com" },
        isPaid: true,
      },
      {
        user: { firstName: "Bob", email: "bob@example.com", phone: "555-1234" },
        isPaid: false,
      },
    ];

    it("should return all participants with contact info when canViewContact is true", () => {
      const result = sanitizeParticipants(participants, true);

      expect(result).toHaveLength(2);
      expect(result[0].user.email).toBe("alice@example.com");
      expect(result[1].user.email).toBe("bob@example.com");
      expect(result[1].user.phone).toBe("555-1234");
    });

    it("should strip contact info from all participants when canViewContact is false", () => {
      const result = sanitizeParticipants(participants, false);

      expect(result).toHaveLength(2);
      expect(result[0].user).not.toHaveProperty("email");
      expect(result[1].user).not.toHaveProperty("email");
      expect(result[1].user).not.toHaveProperty("phone");
      expect(result[0].user.firstName).toBe("Alice");
      expect(result[1].user.firstName).toBe("Bob");
    });

    it("should handle empty array", () => {
      const result = sanitizeParticipants([], false);

      expect(result).toEqual([]);
    });

    it("should preserve non-user fields", () => {
      const result = sanitizeParticipants(participants, false);

      expect(result[0].isPaid).toBe(true);
      expect(result[1].isPaid).toBe(false);
    });
  });

  describe("exact private profile fields", () => {
    it("allows only self or MANAGE_USERS viewers", () => {
      expect(
        canViewExactPrivateProfileFields("user-1", "Participant", "user-1"),
      ).toBe(true);
      expect(
        canViewExactPrivateProfileFields(
          "admin-1",
          "Administrator",
          "user-1",
        ),
      ).toBe(true);
      expect(
        canViewExactPrivateProfileFields("leader-1", "Leader", "user-1"),
      ).toBe(false);
    });

    it("removes phone and birthYear without changing other fields", () => {
      expect(
        stripExactPrivateProfileFields({
          id: "user-1",
          email: "visible@example.com",
          phone: "+12065550123",
          birthYear: 1990,
        }),
      ).toEqual({ id: "user-1", email: "visible@example.com" });
    });
  });
});
