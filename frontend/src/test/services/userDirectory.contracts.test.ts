import { describe, expect, it } from "vitest";
import {
  decodeAdminUser,
  decodeCommunityMember,
  decodeUserPicker,
} from "../../services/api/userDirectory.contracts";

const communityMember = {
  id: "member-1",
  username: "member",
  firstName: "Community",
  lastName: "Member",
  avatar: null,
  gender: "female",
  roleInAtCloud: "Volunteer",
};

const adminUser = {
  ...communityMember,
  email: "member@example.com",
  phone: null,
  homeAddress: null,
  isAtCloudLeader: false,
  occupation: null,
  company: null,
  weeklyChurch: null,
  churchAddress: null,
  role: "Participant",
  isActive: true,
  isVerified: true,
  emailNotifications: true,
  lastLogin: null,
  createdAt: null,
  updatedAt: null,
};

describe("user directory response contracts", () => {
  it("accepts the exact allowlisted shapes", () => {
    expect(decodeCommunityMember(communityMember)).toEqual(communityMember);
    expect(decodeAdminUser(adminUser)).toEqual(adminUser);
    expect(
      decodeUserPicker({
        ...communityMember,
        role: "Leader",
      }),
    ).toEqual({ ...communityMember, role: "Leader" });
  });

  it("rejects contact PII added to a CommunityMemberDTO", () => {
    expect(() =>
      decodeCommunityMember({
        ...communityMember,
        email: "must-not-leak@example.com",
      }),
    ).toThrow(/only keys/);
  });

  it("rejects contact PII added to a UserPickerDTO", () => {
    expect(() =>
      decodeUserPicker({
        ...communityMember,
        role: "Leader",
        phone: "555-0100",
      }),
    ).toThrow(/only keys/);
  });
});
