import type { RuntimeConfigSuccessDTO } from "../../contracts/runtimeConfig";
import { featureControlService } from "../runtime/FeatureControlService";

export interface ProgramMembershipRuntimeReader {
  getOperationalRuntimeConfig(): Promise<RuntimeConfigSuccessDTO>;
}

declare const PROGRAM_MEMBERSHIP_RUNTIME_PERMIT_BRAND: unique symbol;

/** Opaque proof issued only after a successful, writable operational read. */
export interface ProgramMembershipRuntimePermit {
  readonly [PROGRAM_MEMBERSHIP_RUNTIME_PERMIT_BRAND]: true;
}

const issuedPermits = new WeakSet<object>();

/**
 * Strict write gate for Program Room membership projection work. Operational
 * configuration failures intentionally collapse to false so background work
 * can never create or update chat data while runtime state is uncertain.
 */
export async function acquireProgramMembershipRuntimePermit(
  runtimeReader?: ProgramMembershipRuntimeReader,
): Promise<ProgramMembershipRuntimePermit | null> {
  try {
    const reader = runtimeReader ?? featureControlService;
    const runtime = await reader.getOperationalRuntimeConfig();
    const feature = runtime.data.alumniNetwork;
    if (feature.mode !== "on" || feature.writable !== true) return null;
    const permit = Object.freeze({}) as ProgramMembershipRuntimePermit;
    issuedPermits.add(permit);
    return permit;
  } catch {
    return null;
  }
}

export function isProgramMembershipRuntimePermit(
  value: unknown,
): value is ProgramMembershipRuntimePermit {
  return typeof value === "object" && value !== null && issuedPermits.has(value);
}
