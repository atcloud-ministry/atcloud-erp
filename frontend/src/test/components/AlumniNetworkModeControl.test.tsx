import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AlumniNetworkModeControl from "../../components/system/AlumniNetworkModeControl";
import type { RuntimeConfig } from "../../config/runtimeConfig";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  updateAlumniNetworkMode: vi.fn(),
}));

vi.mock("../../services/api/featureControls.api", () => ({
  featureControlsService: {
    get: mocks.get,
    updateAlumniNetworkMode: mocks.updateAlumniNetworkMode,
  },
}));

function runtimeConfig(
  mode: RuntimeConfig["alumniNetwork"]["mode"],
  revision: number,
): RuntimeConfig {
  const capabilities =
    mode === "on"
      ? { readable: true, writable: true }
      : mode === "read_only"
      ? { readable: true, writable: false }
      : { readable: false, writable: false };
  return {
    version: 1,
    revision,
    alumniNetwork: { mode, ...capabilities },
  };
}

function renderControl(onRuntimeConfigRefresh = vi.fn().mockResolvedValue(undefined)) {
  return {
    onRuntimeConfigRefresh,
    user: userEvent.setup(),
    ...render(
      <AlumniNetworkModeControl
        onRuntimeConfigRefresh={onRuntimeConfigRefresh}
      />,
    ),
  };
}

async function waitForLoadedMode(label: string) {
  const values = { Off: "off", "Read-only": "read_only", On: "on" } as const;
  await waitFor(() =>
    expect(screen.getByLabelText("Alumni Network mode")).toHaveValue(
      values[label as keyof typeof values],
    ),
  );
}

async function chooseAndConfirm(
  user: ReturnType<typeof userEvent.setup>,
  target: "off" | "read_only" | "on",
  label: string,
) {
  await user.selectOptions(screen.getByLabelText("Alumni Network mode"), target);
  await user.click(
    screen.getByRole("button", { name: "Apply Alumni Network mode" }),
  );
  await screen.findByRole("dialog", { name: "Change Alumni Network mode" });
  await user.click(screen.getByRole("button", { name: `Set mode to ${label}` }));
}

describe("AlumniNetworkModeControl", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.get.mockResolvedValue(runtimeConfig("off", 4));
    mocks.updateAlumniNetworkMode.mockResolvedValue(runtimeConfig("on", 5));
  });

  it("loads the protected current mode and disables a no-op update", async () => {
    renderControl();

    await waitForLoadedMode("Off");
    expect(mocks.get).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(
      screen.getByRole("button", { name: "Apply Alumni Network mode" }),
    ).toBeDisabled();
  });

  it("confirms an exact revisioned transition and refreshes runtime navigation", async () => {
    const { user, onRuntimeConfigRefresh } = renderControl();

    await waitForLoadedMode("Off");
    await chooseAndConfirm(user, "on", "On");

    await waitFor(() =>
      expect(mocks.updateAlumniNetworkMode).toHaveBeenCalledWith({
        mode: "on",
        expectedRevision: 4,
      }),
    );
    await waitFor(() =>
      expect(onRuntimeConfigRefresh).toHaveBeenCalledOnce(),
    );
    expect(await screen.findByText(/Alumni Network is now On/)).toBeInTheDocument();
    expect(screen.getByLabelText("Alumni Network mode")).toHaveValue("on");
  });

  it("prevents duplicate submit while an update is pending", async () => {
    let resolveUpdate: ((value: RuntimeConfig) => void) | undefined;
    mocks.updateAlumniNetworkMode.mockReturnValueOnce(
      new Promise<RuntimeConfig>((resolve) => {
        resolveUpdate = resolve;
      }),
    );
    const { user } = renderControl();

    await waitForLoadedMode("Off");
    await chooseAndConfirm(user, "on", "On");

    expect(mocks.updateAlumniNetworkMode).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Processing..." })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Apply Alumni Network mode" }),
    ).toBeDisabled();

    resolveUpdate?.(runtimeConfig("on", 5));
    await screen.findByText(/Alumni Network is now On/);
    expect(mocks.updateAlumniNetworkMode).toHaveBeenCalledOnce();
  });

  it("reloads after a revision conflict and never retries the update automatically", async () => {
    mocks.get
      .mockResolvedValueOnce(runtimeConfig("off", 4))
      .mockResolvedValueOnce(runtimeConfig("read_only", 5));
    mocks.updateAlumniNetworkMode.mockRejectedValueOnce(
      Object.assign(new Error("The feature control revision has changed."), {
        status: 409,
      }),
    );
    const { user, onRuntimeConfigRefresh } = renderControl();

    await waitForLoadedMode("Off");
    await chooseAndConfirm(user, "on", "On");

    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    expect(mocks.updateAlumniNetworkMode).toHaveBeenCalledOnce();
    expect(onRuntimeConfigRefresh).not.toHaveBeenCalled();
    expect(
      screen.getByLabelText("Alumni Network mode"),
    ).toHaveValue("read_only");
    expect(
      await screen.findByText(/The setting changed before your update/),
    ).toBeInTheDocument();
  });

  it.each([403, 503])(
    "keeps a %s update failure inside the control card",
    async (status) => {
      mocks.updateAlumniNetworkMode.mockRejectedValueOnce(
        Object.assign(new Error("Request failed"), { status }),
      );
      const { user } = renderControl();

      await waitForLoadedMode("Off");
      await chooseAndConfirm(user, "on", "On");

      expect(await screen.findByRole("alert")).toHaveTextContent(
        status === 403
          ? "Your session cannot change this setting"
          : "Alumni Network controls are temporarily unavailable",
      );
      expect(screen.getByLabelText("Alumni Network mode")).toHaveValue("on");
    },
  );

  it("shows a retryable card-level error when the protected setting cannot load", async () => {
    mocks.get.mockRejectedValueOnce(new Error("network unavailable"));
    renderControl();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to load the Alumni Network setting",
    );
    expect(screen.getByRole("button", { name: "Retry setting load" })).toBeInTheDocument();
  });
});
