import { describe, expect, it, vi } from "vitest";
import { createRuntimeConfigDTO } from "../../../../src/contracts/runtimeConfig";
import {
  acquireProgramMembershipRuntimePermit,
  isProgramMembershipRuntimePermit,
} from "../../../../src/services/programs/ProgramMembershipRuntimeGate";

describe("ProgramMembershipRuntimeGate", () => {
  it.each(["off", "read_only"] as const)(
    "does not issue a write permit while Alumni runtime is %s",
    async (mode) => {
      const runtimeReader = {
        getOperationalRuntimeConfig: vi
          .fn()
          .mockResolvedValue(createRuntimeConfigDTO(mode, 3)),
      };

      await expect(
        acquireProgramMembershipRuntimePermit(runtimeReader),
      ).resolves.toBeNull();
    },
  );

  it("issues an opaque permit only while Alumni runtime is on and writable", async () => {
    const runtimeReader = {
      getOperationalRuntimeConfig: vi
        .fn()
        .mockResolvedValue(createRuntimeConfigDTO("on", 4)),
    };

    const permit = await acquireProgramMembershipRuntimePermit(runtimeReader);

    expect(permit).not.toBeNull();
    expect(isProgramMembershipRuntimePermit(permit)).toBe(true);
    expect(isProgramMembershipRuntimePermit(Object.freeze({}))).toBe(false);
  });

  it("fails closed when operational runtime configuration cannot be loaded", async () => {
    const runtimeReader = {
      getOperationalRuntimeConfig: vi
        .fn()
        .mockRejectedValue(new Error("runtime unavailable")),
    };

    await expect(
      acquireProgramMembershipRuntimePermit(runtimeReader),
    ).resolves.toBeNull();
  });
});
