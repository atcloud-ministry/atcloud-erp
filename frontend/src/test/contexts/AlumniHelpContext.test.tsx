import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AlumniHelpProvider,
  isAlumniHelpUpdatePayload,
  useAlumniHelp,
} from "../../contexts/AlumniHelpContext";

const mocks = vi.hoisted(() => ({
  getActionRequiredCount: vi.fn(),
  socketHandler: null as ((payload: unknown) => void) | null,
}));

vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({ currentUser: { id: "64b000000000000000000001" } }),
}));

vi.mock("../../hooks/useSocket", () => ({ useSocket: vi.fn() }));

vi.mock("../../contexts/RuntimeConfigContext", () => ({
  useRuntimeConfig: () => ({
    status: "ready",
    config: {
      alumniNetwork: { mode: "on", readable: true, writable: true },
    },
  }),
}));

vi.mock("../../services/api", () => ({
  alumniHelpService: {
    getActionRequiredCount: mocks.getActionRequiredCount,
  },
}));

vi.mock("../../services/socketService", () => ({
  socketService: {
    on: vi.fn((_event: string, handler: (payload: unknown) => void) => {
      mocks.socketHandler = handler;
      return () => {
        mocks.socketHandler = null;
      };
    }),
  },
}));

function CountProbe() {
  const { helpActionRequiredCount } = useAlumniHelp();
  return <output aria-label="Alumni Help action count">{helpActionRequiredCount}</output>;
}

describe("AlumniHelpProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.socketHandler = null;
    mocks.getActionRequiredCount.mockResolvedValue(2);
  });

  it("loads the count and accepts only validated realtime count updates", async () => {
    render(
      <AlumniHelpProvider>
        <CountProbe />
      </AlumniHelpProvider>,
    );

    await waitFor(() =>
      expect(screen.getByLabelText("Alumni Help action count")).toHaveTextContent("2"),
    );
    expect(mocks.getActionRequiredCount).toHaveBeenCalledOnce();

    act(() => {
      mocks.socketHandler?.({
        requestId: "64b000000000000000000002",
        requestRevision: 1,
        helpActionRequiredCount: 5,
        timestamp: "2026-09-12T13:00:00.000Z",
      });
    });
    expect(screen.getByLabelText("Alumni Help action count")).toHaveTextContent("5");

    mocks.getActionRequiredCount.mockResolvedValue(4);
    act(() => mocks.socketHandler?.({ helpActionRequiredCount: -1 }));
    await waitFor(() =>
      expect(screen.getByLabelText("Alumni Help action count")).toHaveTextContent("4"),
    );
    expect(mocks.getActionRequiredCount).toHaveBeenCalledTimes(2);
  });

  it("requires the exact metadata-only Alumni Help event shape", () => {
    const valid = {
      requestId: "64b000000000000000000002",
      requestRevision: 1,
      helpActionRequiredCount: 0,
      timestamp: "2026-09-13T12:00:00.000Z",
    };
    expect(isAlumniHelpUpdatePayload(valid)).toBe(true);
    expect(isAlumniHelpUpdatePayload({ ...valid, message: "private text" })).toBe(
      false,
    );
    expect(
      isAlumniHelpUpdatePayload({
        ...valid,
        timestamp: "2026-09-13T05:00:00-07:00",
      }),
    ).toBe(false);
  });
});
