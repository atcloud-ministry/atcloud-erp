import type { FilterQuery } from "mongoose";
import {
  type AdminUsersQuery,
  type CommunityMembersQuery,
  type UserOptionsQuery,
} from "../contracts/userReadContracts";
import { User, type IUser } from "../models";
import {
  ADMIN_USER_PROJECTION,
  ADMIN_USER_QUERY_PROJECTION,
  COMMUNITY_MEMBER_PROJECTION,
  USER_PICKER_PROJECTION,
  serializeAdminUser,
  serializeCommunityMember,
  serializeUserPicker,
} from "../serializers/userReadSerializers";
import { escapeRegex } from "../utils/search";
import { ROLES } from "../utils/roleUtils";

function regexFor(value: string): { $regex: string; $options: "i" } {
  return { $regex: escapeRegex(value), $options: "i" };
}

function pagination(page: number, limit: number, total: number) {
  const totalPages = Math.ceil(total / limit);
  return {
    currentPage: page,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}

export class UserReadService {
  static async listCommunityMembers(query: CommunityMembersQuery) {
    const filter: FilterQuery<IUser> = { isActive: true, isVerified: true };
    if (query.q) {
      const match = regexFor(query.q);
      filter.$or = [
        { username: match },
        { firstName: match },
        { lastName: match },
        { roleInAtCloud: match },
      ];
    }

    const skip = (query.page - 1) * query.limit;
    const sort = {
      [query.sortBy]: query.sortOrder === "desc" ? (-1 as const) : (1 as const),
      _id: 1 as const,
    };
    const [rows, totalMembers] = await Promise.all([
      User.find(filter)
        .select(COMMUNITY_MEMBER_PROJECTION)
        .sort(sort)
        .skip(skip)
        .limit(query.limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    return {
      members: rows.map(serializeCommunityMember),
      pagination: {
        ...pagination(query.page, query.limit, totalMembers),
        totalMembers,
      },
    };
  }

  static async getCommunityMember(id: string) {
    const row = await User.findOne({
      _id: id,
      isActive: true,
      isVerified: true,
    })
      .select(COMMUNITY_MEMBER_PROJECTION)
      .lean();
    return row ? serializeCommunityMember(row) : null;
  }

  static async listAdminUsers(query: AdminUsersQuery) {
    const filter: FilterQuery<IUser> = {};
    if (query.role !== undefined) filter.role = query.role;
    if (query.isActive !== undefined) filter.isActive = query.isActive;
    if (query.isVerified !== undefined) filter.isVerified = query.isVerified;
    if (query.isAtCloudLeader !== undefined) {
      filter.isAtCloudLeader = query.isAtCloudLeader;
    }
    if (query.gender !== undefined) filter.gender = query.gender;
    if (query.q) {
      const match = regexFor(query.q);
      filter.$or = [
        { username: match },
        { email: match },
        { phone: match },
        { firstName: match },
        { lastName: match },
      ];
    }

    const skip = (query.page - 1) * query.limit;
    let rowsPromise: Promise<unknown[]>;
    if (query.sortBy === "role") {
      const project = Object.fromEntries(
        ADMIN_USER_PROJECTION.split(" ").map((field) => [field, 1]),
      );
      rowsPromise = User.aggregate([
        { $match: filter },
        {
          $addFields: {
            _roleRank: {
              $switch: {
                branches: [
                  { case: { $eq: ["$role", ROLES.PARTICIPANT] }, then: 0 },
                  { case: { $eq: ["$role", ROLES.GUEST_EXPERT] }, then: 1 },
                  { case: { $eq: ["$role", ROLES.LEADER] }, then: 2 },
                  { case: { $eq: ["$role", ROLES.ADMINISTRATOR] }, then: 3 },
                  { case: { $eq: ["$role", ROLES.SUPER_ADMIN] }, then: 4 },
                ],
                default: 0,
              },
            },
          },
        },
        {
          $sort: {
            _roleRank: query.sortOrder === "desc" ? -1 : 1,
            _id: 1,
          },
        },
        { $project: project },
        { $skip: skip },
        { $limit: query.limit },
      ]) as Promise<unknown[]>;
    } else {
      rowsPromise = User.find(filter)
        .select(ADMIN_USER_QUERY_PROJECTION)
        .sort({
          [query.sortBy]: query.sortOrder === "desc" ? -1 : 1,
          _id: 1,
        })
        .skip(skip)
        .limit(query.limit)
        .lean() as unknown as Promise<unknown[]>;
    }

    const [rows, totalUsers] = await Promise.all([
      rowsPromise,
      User.countDocuments(filter),
    ]);
    return {
      users: rows.map(serializeAdminUser),
      pagination: {
        ...pagination(query.page, query.limit, totalUsers),
        totalUsers,
      },
    };
  }

  static async getAdminUser(id: string) {
    const row = await User.findById(id)
      .select(ADMIN_USER_QUERY_PROJECTION)
      .lean();
    return row ? serializeAdminUser(row) : null;
  }

  static async listUserOptions(query: UserOptionsQuery) {
    const filter: FilterQuery<IUser> = { isActive: true, isVerified: true };
    if (query.context !== "event-role-assignee") {
      filter.role = {
        $in: [ROLES.LEADER, ROLES.ADMINISTRATOR, ROLES.SUPER_ADMIN],
      };
    }
    if (query.q) {
      const match = regexFor(query.q);
      filter.$or = [
        { username: match },
        { firstName: match },
        { lastName: match },
        { roleInAtCloud: match },
      ];
    }

    const skip = (query.page - 1) * query.limit;
    const [rows, totalOptions] = await Promise.all([
      User.find(filter)
        .select(USER_PICKER_PROJECTION)
        .sort({ firstName: 1, lastName: 1, _id: 1 })
        .skip(skip)
        .limit(query.limit)
        .lean(),
      User.countDocuments(filter),
    ]);
    return {
      options: rows.map(serializeUserPicker),
      pagination: {
        ...pagination(query.page, query.limit, totalOptions),
        totalOptions,
      },
    };
  }
}
