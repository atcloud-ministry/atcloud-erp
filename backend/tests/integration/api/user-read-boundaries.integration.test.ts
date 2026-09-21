import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../../../src/app";
import User from "../../../src/models/User";
import { TokenService } from "../../../src/middleware/auth";
import type { UserRole } from "../../../src/utils/roleUtils";
import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";

type SeededUser = {
  id: string;
  token: string;
};

async function createUser(
  suffix: string,
  role: UserRole,
  extra: Record<string, unknown> = {},
): Promise<SeededUser> {
  const user = await User.create({
    ...TEST_REGISTRATION_PROFILE,
    username: `user_${suffix}`,
    email: `${suffix}@example.com`,
    password: "Password123!",
    firstName: `First${suffix}`,
    lastName: `Last${suffix}`,
    gender: "male",
    role,
    isActive: true,
    isVerified: true,
    ...extra,
  });
  return {
    id: String(user._id),
    token: TokenService.generateAccessToken({
      userId: String(user._id),
      email: user.email,
      role: user.role,
    }),
  };
}

describe("page-specific user read APIs", () => {
  let participant: SeededUser;
  let admin: SeededUser;
  let leader: SeededUser;

  beforeEach(async () => {
    await User.deleteMany({});
    participant = await createUser("participant", "Participant");
    admin = await createUser("administrator", "Administrator");
    leader = await createUser("leader", "Leader", {
      firstName: "Amy",
      lastName: "Chen",
      email: "private-amy@example.com",
      phone: "+12065550111",
      birthYear: 1988,
      residenceCity: "Bellevue",
      residenceRegion: "US-WA",
      residenceCountryCode: "US",
      employmentStatus: "employed",
      homeAddress: "Private address",
      company: "Private company",
      isAtCloudLeader: true,
      roleInAtCloud: "Mentor",
    });
    await createUser("inactive", "Leader", { isActive: false });
    await createUser("unverified", "Leader", { isVerified: false });
  });

  afterEach(async () => {
    await User.deleteMany({});
  });

  it("returns only active verified CommunityMemberDTO rows", async () => {
    const response = await request(app)
      .get("/api/community/members?q=Amy")
      .set("Authorization", `Bearer ${participant.token}`)
      .expect(200);

    expect(response.body.data.members).toHaveLength(1);
    expect(response.body.data.members[0]).toEqual({
      id: leader.id,
      username: "user_leader",
      firstName: "Amy",
      lastName: "Chen",
      avatar: "/default-avatar-male.jpg",
      gender: "male",
      roleInAtCloud: "Mentor",
    });
    expect(response.body.data.members[0]).not.toHaveProperty("email");
    expect(response.body.data.members[0]).not.toHaveProperty("phone");
    expect(response.body.data.members[0]).not.toHaveProperty("birthYear");
    expect(response.body.data.members[0]).not.toHaveProperty("role");
  });

  it("cannot infer a member by searching their private email", async () => {
    const response = await request(app)
      .get("/api/community/members?q=private-amy%40example.com")
      .set("Authorization", `Bearer ${participant.token}`)
      .expect(200);
    expect(response.body.data.members).toEqual([]);
  });

  it("protects AdminUserDTO list/detail and legacy reads with MANAGE_USERS", async () => {
    await request(app)
      .get("/api/admin/users")
      .set("Authorization", `Bearer ${participant.token}`)
      .expect(403);
    await request(app)
      .get("/api/users")
      .set("Authorization", `Bearer ${participant.token}`)
      .expect(403);
    await request(app)
      .get(`/api/users/${leader.id}`)
      .set("Authorization", `Bearer ${participant.token}`)
      .expect(403);

    const response = await request(app)
      .get(`/api/admin/users/${leader.id}`)
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);
    expect(response.body.data.user).toMatchObject({
      id: leader.id,
      email: "private-amy@example.com",
      phone: "+12065550111",
      birthYear: 1988,
      residenceCity: "Bellevue",
      residenceRegion: "US-WA",
      residenceCountryCode: "US",
      employmentStatus: "employed",
      company: "Private company",
      occupation: "Tester",
      homeAddress: "Private address",
    });
    expect(response.body.data.user).not.toHaveProperty("password");

    const listResponse = await request(app)
      .get("/api/admin/users?q=Amy")
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);
    const listedLeader = listResponse.body.data.users.find(
      (user: { id: string }) => user.id === leader.id,
    );
    expect(listedLeader).toMatchObject({
      phone: "+12065550111",
      birthYear: 1988,
      residenceCity: "Bellevue",
      residenceRegion: "US-WA",
      residenceCountryCode: "US",
      employmentStatus: "employed",
      company: "Private company",
      occupation: "Tester",
    });
  });

  it("returns only UserPickerDTO fields for authorized assignment flows", async () => {
    const response = await request(app)
      .get("/api/user-options?context=program-mentor&q=Amy")
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);
    expect(response.body.data.options).toHaveLength(1);
    expect(response.body.data.options[0]).toEqual({
      id: leader.id,
      username: "user_leader",
      firstName: "Amy",
      lastName: "Chen",
      avatar: "/default-avatar-male.jpg",
      gender: "male",
      role: "Leader",
      roleInAtCloud: "Mentor",
    });
    expect(response.body.data.options[0]).not.toHaveProperty("email");
    expect(response.body.data.options[0]).not.toHaveProperty("phone");
    expect(response.body.data.options[0]).not.toHaveProperty("birthYear");

    await request(app)
      .get("/api/user-options?context=program-mentor")
      .set("Authorization", `Bearer ${participant.token}`)
      .expect(403);
    await request(app)
      .get("/api/user-options?context=event-role-assignee")
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(400);
  });

  it("keeps global search on CommunityMemberDTO even for an admin", async () => {
    const byPrivateEmail = await request(app)
      .get("/api/search/global?q=private-amy%40example.com")
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);
    expect(byPrivateEmail.body.data.users).toEqual([]);

    const byName = await request(app)
      .get("/api/search/global?q=Amy")
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);
    expect(byName.body.data.users).toHaveLength(1);
    expect(byName.body.data.users[0]).not.toHaveProperty("email");
    expect(byName.body.data.users[0]).not.toHaveProperty("phone");
    expect(byName.body.data.users[0]).not.toHaveProperty("birthYear");
    expect(byName.body.data.users[0]).not.toHaveProperty("homeAddress");
  });
});
