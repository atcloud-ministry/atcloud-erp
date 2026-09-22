import { BaseApiClient } from "./common";

export interface AlumniInvitationClaimDTO {
  invitationId: string;
  alumniProfileId: string;
  affiliationIds: string[];
  claimedAt: string;
  status: "claimed";
  replayed: boolean;
}

type JsonObject = Record<string, unknown>;
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

function asExactObject(
  value: unknown,
  path: string,
  keys: readonly string[],
): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid API response at ${path}: expected object`);
  }
  const object = value as JsonObject;
  const allowed = new Set(keys);
  if (Object.keys(object).some((key) => !allowed.has(key))) {
    throw new Error(`Invalid API response at ${path}: unexpected field`);
  }
  return object;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid API response at ${path}: expected string`);
  }
  return value;
}

function objectIdString(value: unknown, path: string): string {
  const result = requiredString(value, path);
  if (!OBJECT_ID_PATTERN.test(result)) {
    throw new Error(`Invalid API response at ${path}: expected ObjectId`);
  }
  return result;
}

export function decodeAlumniInvitationClaim(
  value: unknown,
): AlumniInvitationClaimDTO {
  const result = asExactObject(value, "data", [
    "invitationId",
    "alumniProfileId",
    "affiliationIds",
    "claimedAt",
    "status",
    "replayed",
  ]);
  if (!Array.isArray(result.affiliationIds)) {
    throw new Error(
      "Invalid API response at data.affiliationIds: expected array",
    );
  }
  if (result.affiliationIds.length > 50) {
    throw new Error(
      "Invalid API response at data.affiliationIds: too many affiliations",
    );
  }
  const affiliationIds = result.affiliationIds.map((entry, index) =>
    objectIdString(entry, `data.affiliationIds[${index}]`),
  );
  if (result.status !== "claimed" || typeof result.replayed !== "boolean") {
    throw new Error("Invalid alumni invitation claim response");
  }
  const claimedAt = requiredString(result.claimedAt, "data.claimedAt");
  if (Number.isNaN(Date.parse(claimedAt))) {
    throw new Error("Invalid API response at data.claimedAt: expected date");
  }
  return {
    invitationId: objectIdString(result.invitationId, "data.invitationId"),
    alumniProfileId: objectIdString(
      result.alumniProfileId,
      "data.alumniProfileId",
    ),
    affiliationIds,
    claimedAt,
    status: "claimed",
    replayed: result.replayed,
  };
}

class AlumniInvitationsApiClient extends BaseApiClient {
  async claim(
    token: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<AlumniInvitationClaimDTO> {
    const response = await this.request<unknown>("/alumni-invitations/claim", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ token }),
      signal,
    });
    if (response.data === undefined) {
      throw new Error(response.message || "Unable to claim alumni invitation");
    }
    return decodeAlumniInvitationClaim(response.data);
  }
}

const client = new AlumniInvitationsApiClient();

export const alumniInvitationsService = {
  claim: (token: string, idempotencyKey: string, signal?: AbortSignal) =>
    client.claim(token, idempotencyKey, signal),
};
