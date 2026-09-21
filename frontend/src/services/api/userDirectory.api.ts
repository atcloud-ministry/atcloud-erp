import { BaseApiClient } from "./common";
import {
  decodeAdminUserDetail,
  decodeAdminUsersPage,
  decodeCommunityMemberDetail,
  decodeCommunityMembersPage,
  decodeUserOptionsPage,
  type AdminUsersPageDTO,
  type AdminUserDTO,
  type CommunityMemberDTO,
  type CommunityMembersPageDTO,
  type UserGender,
  type UserOptionContext,
  type UserOptionsPageDTO,
  type UserRole,
} from "./userDirectory.contracts";

export interface AdminUserListParams {
  page?: number;
  limit?: number;
  q?: string;
  role?: UserRole;
  isActive?: boolean;
  isVerified?: boolean;
  isAtCloudLeader?: boolean;
  gender?: UserGender;
  sortBy?:
    | "createdAt"
    | "firstName"
    | "lastName"
    | "username"
    | "email"
    | "role"
    | "gender"
    | "isActive"
    | "isVerified"
    | "isAtCloudLeader"
    | "lastLogin";
  sortOrder?: "asc" | "desc";
}

export interface CommunityMemberListParams {
  page?: number;
  limit?: number;
  q?: string;
  sortBy?: "firstName" | "lastName" | "username";
  sortOrder?: "asc" | "desc";
}

export interface UserOptionListParams {
  context: UserOptionContext;
  resourceId?: string;
  page?: number;
  limit?: number;
  q?: string;
}

function withQuery(
  endpoint: string,
  params?: Record<string, string | number | boolean | undefined>,
) {
  const query = new URLSearchParams();
  Object.entries(params ?? {}).forEach(([key, value]) => {
    if (value !== undefined) query.set(key, String(value));
  });
  const serialized = query.toString();
  return serialized ? `${endpoint}?${serialized}` : endpoint;
}

class AdminUsersApiClient extends BaseApiClient {
  async list(params: AdminUserListParams = {}): Promise<AdminUsersPageDTO> {
    const response = await this.request<unknown>(
      withQuery("/admin/users", { ...params }),
    );
    if (response.data === undefined) {
      throw new Error(response.message || "Failed to get users");
    }
    return decodeAdminUsersPage(response.data);
  }

  async get(userId: string): Promise<AdminUserDTO> {
    const response = await this.request<unknown>(
      `/admin/users/${encodeURIComponent(userId)}`,
    );
    if (response.data === undefined) {
      throw new Error(response.message || "Failed to get user");
    }
    return decodeAdminUserDetail(response.data);
  }
}

class CommunityMembersApiClient extends BaseApiClient {
  async list(
    params: CommunityMemberListParams = {},
  ): Promise<CommunityMembersPageDTO> {
    const response = await this.request<unknown>(
      withQuery("/community/members", { ...params }),
    );
    if (response.data === undefined) {
      throw new Error(response.message || "Failed to get community members");
    }
    return decodeCommunityMembersPage(response.data);
  }

  async get(memberId: string): Promise<CommunityMemberDTO> {
    const response = await this.request<unknown>(
      `/community/members/${encodeURIComponent(memberId)}`,
    );
    if (response.data === undefined) {
      throw new Error(response.message || "Failed to get community member");
    }
    return decodeCommunityMemberDetail(response.data);
  }
}

class UserOptionsApiClient extends BaseApiClient {
  async list(params: UserOptionListParams): Promise<UserOptionsPageDTO> {
    const response = await this.request<unknown>(
      withQuery("/user-options", { ...params }),
    );
    if (response.data === undefined) {
      throw new Error(response.message || "Failed to get user options");
    }
    return decodeUserOptionsPage(response.data);
  }
}

const adminUsersApiClient = new AdminUsersApiClient();
const communityMembersApiClient = new CommunityMembersApiClient();
const userOptionsApiClient = new UserOptionsApiClient();

export const adminUsersService = {
  list: (params?: AdminUserListParams) => adminUsersApiClient.list(params),
  get: (userId: string) => adminUsersApiClient.get(userId),
};

export const communityMembersService = {
  list: (params?: CommunityMemberListParams) =>
    communityMembersApiClient.list(params),
  get: (memberId: string) => communityMembersApiClient.get(memberId),
};

export const userOptionsService = {
  list: (params: UserOptionListParams) => userOptionsApiClient.list(params),
};

export type {
  AdminUserDTO,
  AdminUsersPageDTO,
  CommunityMemberDTO,
  CommunityMembersPageDTO,
  UserPickerDTO,
  UserOptionContext,
  UserOptionsPageDTO,
} from "./userDirectory.contracts";
