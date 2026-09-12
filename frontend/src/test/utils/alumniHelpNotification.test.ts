import { describe, expect, it } from "vitest";
import { getAlumniHelpRequestPath } from "../../utils/alumniHelpNotification";

describe("getAlumniHelpRequestPath", () => {
  it("derives the fixed internal route from valid workflow metadata", () => {
    expect(
      getAlumniHelpRequestPath({
        kind: "alumni_help_workflow",
        requestId: "ABCDEFabcdef012345678901",
      }),
    ).toBe(
      "/dashboard/community/help-requests/abcdefabcdef012345678901",
    );
  });

  it.each([
    null,
    { kind: "alumni_help_workflow", requestId: "not-an-id" },
    { kind: "other", requestId: "abcdefabcdef012345678901" },
    {
      kind: "alumni_help_workflow",
      requestId: "abcdefabcdef012345678901",
      url: "https://attacker.invalid",
    },
  ])("does not use an arbitrary or invalid navigation target", (metadata) => {
    const result = getAlumniHelpRequestPath(metadata);
    if (
      metadata &&
      typeof metadata === "object" &&
      "kind" in metadata &&
      metadata.kind === "alumni_help_workflow" &&
      "requestId" in metadata &&
      metadata.requestId === "abcdefabcdef012345678901"
    ) {
      expect(result).toBe(
        "/dashboard/community/help-requests/abcdefabcdef012345678901",
      );
    } else {
      expect(result).toBeNull();
    }
  });
});
