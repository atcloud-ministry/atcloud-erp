import { describe, expect, it } from "vitest";
import {
  serializeAdminUser,
  serializeCommunityMember,
  serializeSelfUser,
  serializeUserPicker,
} from "../../../src/serializers/userReadSerializers";

const source = {
  _id: "507f191e810c19729de860ea",
  username: "amy",
  email: "amy@example.com",
  phone: "555-0100",
  birthYear: 1988,
  residenceCity: "Seattle",
  residenceRegion: "US-WA",
  residenceCountryCode: "US",
  employmentStatus: "employed",
  passwordResetToken: "secret",
  firstName: "Amy",
  lastName: "Chen",
  gender: "female",
  avatar: "/amy.jpg",
  role: "Leader",
  roleInAtCloud: "Mentor",
  homeAddress: "Private address",
  isVerified: true,
};

describe("page-specific user serializers", () => {
  it("keeps community output to its explicit public allowlist", () => {
    const dto = serializeCommunityMember(source);
    expect(dto).toEqual({
      id: source._id,
      username: "amy",
      firstName: "Amy",
      lastName: "Chen",
      avatar: "/amy.jpg",
      gender: "female",
      roleInAtCloud: "Mentor",
    });
    expect(dto).not.toHaveProperty("email");
    expect(dto).not.toHaveProperty("role");
  });

  it("never exposes contact fields through picker output", () => {
    const dto = serializeUserPicker(source);
    expect(dto).not.toHaveProperty("email");
    expect(dto).not.toHaveProperty("phone");
    expect(dto).not.toHaveProperty("homeAddress");
    expect(dto.role).toBe("Leader");
  });

  it("uses model-compatible defaults for legacy admin rows", () => {
    const dto = serializeAdminUser(source);
    expect(dto.isActive).toBe(true);
    expect(dto.emailNotifications).toBe(true);
    expect(dto.isAtCloudLeader).toBe(false);
    expect(dto).not.toHaveProperty("passwordResetToken");
  });

  it("returns private profile fields only through explicit owner/admin serializers", () => {
    const own = serializeSelfUser(source);
    const admin = serializeAdminUser(source);
    const community = serializeCommunityMember(source);

    expect(own).toMatchObject({ phone: "555-0100", birthYear: 1988 });
    expect(admin).toMatchObject({ phone: "555-0100", birthYear: 1988 });
    expect(community).not.toHaveProperty("phone");
    expect(community).not.toHaveProperty("birthYear");
  });
});
