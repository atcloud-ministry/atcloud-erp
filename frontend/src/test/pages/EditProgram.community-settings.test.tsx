import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationProvider } from "../../contexts/NotificationModalContext";
import EditProgram from "../../pages/EditProgram";

const mocks = vi.hoisted(() => ({
  program: {
    getById: vi.fn(),
    updateProgram: vi.fn(),
    getCommunitySettings: vi.fn(),
    updateCommunitySettings: vi.fn(),
  },
  purchase: { checkProgramAccess: vi.fn() },
  runtime: {
    status: "ready" as "loading" | "ready" | "error",
    mode: "on" as "off" | "read_only" | "on",
    readable: true,
    writable: true,
  },
}));

vi.mock("../../services/api", () => ({
  programService: mocks.program,
  purchaseService: mocks.purchase,
  fileService: { uploadGenericImage: vi.fn() },
  userOptionsService: {
    list: vi.fn().mockResolvedValue({
      options: [],
      pagination: {
        currentPage: 1,
        totalPages: 0,
        totalOptions: 0,
        hasNext: false,
        hasPrev: false,
      },
    }),
  },
}));

vi.mock("../../contexts/RuntimeConfigContext", () => ({
  useRuntimeConfig: () => ({
    status: mocks.runtime.status,
    config: {
      version: 1,
      revision: 1,
      alumniNetwork: {
        mode: mocks.runtime.mode,
        readable: mocks.runtime.readable,
        writable: mocks.runtime.writable,
      },
    },
    refresh: vi.fn(),
  }),
}));

vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({
    currentUser: {
      id: "507f191e810c19729de860aa",
      firstName: "Admin",
      lastName: "User",
      role: "Super Admin",
    },
  }),
}));

vi.mock("../../hooks/useProgramValidation", () => ({
  useProgramValidation: () => ({
    validations: {
      title: { isValid: true, message: "", color: "text-green-600" },
      programType: { isValid: true, message: "", color: "text-green-600" },
      hostedBy: { isValid: true, message: "", color: "text-green-600" },
      introduction: { isValid: true, message: "", color: "text-green-600" },
      flyerUrl: { isValid: true, message: "", color: "text-green-600" },
      fullPriceTicket: { isValid: true, message: "", color: "text-green-600" },
      classRepDiscount: { isValid: true, message: "", color: "text-green-600" },
      earlyBirdDiscount: { isValid: true, message: "", color: "text-green-600" },
      earlyBirdDeadline: { isValid: true, message: "", color: "text-green-600" },
      period: { isValid: true, message: "", color: "text-green-600" },
      mentors: { isValid: true, message: "", color: "text-green-600" },
      startYear: { isValid: true, message: "", color: "text-green-600" },
      startMonth: { isValid: true, message: "", color: "text-green-600" },
      endYear: { isValid: true, message: "", color: "text-green-600" },
      endMonth: { isValid: true, message: "", color: "text-green-600" },
    },
    overallStatus: { isValid: true, errorCount: 0, message: "", color: "" },
  }),
}));

const PROGRAM_ID = "507f191e810c19729de860ea";
const ROOM_ID = "507f191e810c19729de860eb";
const SETTINGS_ID = "507f191e810c19729de860ec";
const programRoles = {
  teacherRoleName: "Mentor",
  studentRoles: [
    {
      id: "participant",
      name: "Participant",
      discountEligible: false,
      discountAmount: 0,
      limit: 0,
      count: 0,
    },
    {
      id: "class-rep",
      name: "Class Representative",
      discountEligible: true,
      discountAmount: 0,
      limit: 0,
      count: 0,
    },
  ],
};
const program = {
  id: PROGRAM_ID,
  title: "M6 Program",
  programType: "EMBA Mentor Circles",
  hostedBy: "@Cloud Marketplace Ministry",
  period: {
    startYear: "2026",
    startMonth: "01",
    endYear: "2026",
    endMonth: "12",
  },
  introduction: "Program introduction",
  flyerUrl: "",
  isFree: true,
  fullPriceTicket: 0,
  classRepDiscount: 0,
  earlyBirdDiscount: 0,
  classRepLimit: 0,
  mentors: [],
  programRoles,
};

function settings(
  overrides: Record<string, unknown> = {},
) {
  return {
    id: null,
    programId: PROGRAM_ID,
    primaryConversationId: null,
    enabled: false,
    opensAt: null,
    closesAt: null,
    archivedAt: null,
    studentRoleMappings: [
      { studentRoleId: "participant", memberRole: "mentee" as const },
      {
        studentRoleId: "class-rep",
        memberRole: "class_representative" as const,
      },
    ],
    revision: 0,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function enabledSettings() {
  return settings({
    id: SETTINGS_ID,
    primaryConversationId: ROOM_ID,
    enabled: true,
    opensAt: "2026-09-12T15:00:00.000Z",
    revision: 1,
    createdAt: "2026-09-12T16:00:00.000Z",
    updatedAt: "2026-09-12T16:00:00.000Z",
  });
}

function renderPage() {
  return render(
    <NotificationProvider>
      <MemoryRouter initialEntries={[`/dashboard/programs/${PROGRAM_ID}/edit`]}>
        <Routes>
          <Route
            path="/dashboard/programs/:id/edit"
            element={<EditProgram />}
          />
          <Route
            path="/dashboard/programs/:id"
            element={<div>Program Detail</div>}
          />
        </Routes>
      </MemoryRouter>
    </NotificationProvider>,
  );
}

async function enableRoomAndSubmit() {
  await screen.findByRole("heading", { name: "Program Chat Room" });
  fireEvent.click(await screen.findByLabelText(/Enable Program Chat Room/u));
  fireEvent.change(screen.getByLabelText("Opens at (UTC) *"), {
    target: { value: "2026-09-12T15:00" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Update Program" }));
}

describe("EditProgram Program Chat Room settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.runtime, {
      status: "ready",
      mode: "on",
      readable: true,
      writable: true,
    });
    mocks.program.getById.mockResolvedValue(program);
    mocks.program.getCommunitySettings.mockResolvedValue(settings());
    mocks.program.updateProgram.mockResolvedValue({ success: true });
    mocks.program.updateCommunitySettings.mockResolvedValue(
      enabledSettings(),
    );
    mocks.purchase.checkProgramAccess.mockResolvedValue({
      hasAccess: true,
      reason: "admin",
    });
  });

  it("saves the Program first, then exact UTC/revision settings without lifecycle fields", async () => {
    renderPage();
    await enableRoomAndSubmit();

    await waitFor(() =>
      expect(mocks.program.updateCommunitySettings).toHaveBeenCalledOnce(),
    );
    expect(mocks.program.updateProgram).toHaveBeenCalledOnce();
    const [programId, input, key] =
      mocks.program.updateCommunitySettings.mock.calls[0];
    expect(programId).toBe(PROGRAM_ID);
    expect(input).toEqual({
      enabled: true,
      opensAt: "2026-09-12T15:00:00.000Z",
      closesAt: null,
      studentRoleMappings: settings().studentRoleMappings,
      expectedRevision: 0,
    });
    expect(input).not.toHaveProperty("archivedAt");
    expect(key).toMatch(/^[a-f\d-]{36}$/u);
    expect(await screen.findByText("Program Detail")).toBeInTheDocument();
  });

  it("reports a partial save and retries only settings with the same key", async () => {
    mocks.program.updateCommunitySettings
      .mockRejectedValueOnce(new Error("Temporary write failure"))
      .mockResolvedValueOnce(enabledSettings());
    renderPage();
    await enableRoomAndSubmit();

    expect(
      await screen.findByText(
        /Program details were saved, but Chat Room settings were not saved/u,
      ),
    ).toBeInTheDocument();
    const firstKey = mocks.program.updateCommunitySettings.mock.calls[0][2];

    fireEvent.click(screen.getByRole("button", { name: "Update Program" }));
    await screen.findByText("Program Detail");

    expect(mocks.program.updateProgram).toHaveBeenCalledOnce();
    expect(mocks.program.updateCommunitySettings).toHaveBeenCalledTimes(2);
    expect(mocks.program.updateCommunitySettings.mock.calls[1][2]).toBe(
      firstKey,
    );
  });

  it("does not rewrite precise Room timestamps when only the Program title changes", async () => {
    mocks.program.getCommunitySettings.mockResolvedValueOnce(
      enabledSettings().opensAt
        ? {
            ...enabledSettings(),
            opensAt: "2026-09-12T15:00:30.500Z",
            closesAt: "2026-10-12T15:00:45.125Z",
          }
        : enabledSettings(),
    );
    renderPage();
    await screen.findByRole("heading", { name: "Program Chat Room" });
    expect(screen.getByLabelText("Opens at (UTC) *")).toHaveValue(
      "2026-09-12T15:00:30.500",
    );

    fireEvent.change(screen.getByLabelText(/Program Title/u), {
      target: { value: "Title-only update" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update Program" }));

    await waitFor(() => expect(mocks.program.updateProgram).toHaveBeenCalledOnce());
    expect(mocks.program.updateCommunitySettings).not.toHaveBeenCalled();
  });

  it("blocks core updates until a failed settings load is reloaded", async () => {
    mocks.program.getCommunitySettings
      .mockRejectedValueOnce(new Error("Settings unavailable"))
      .mockResolvedValueOnce(settings());
    renderPage();

    expect(await screen.findByText("Settings unavailable")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Program Title/u), {
      target: { value: "Updated M6 Program" },
    });
    expect(screen.getByRole("button", { name: "Update Program" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Reload settings" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Update Program" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Update Program" }));
    await waitFor(() => expect(mocks.program.updateProgram).toHaveBeenCalledOnce());
  });

  it("allows a core edit for a disabled read-only Room but blocks active mapping drift", async () => {
    Object.assign(mocks.runtime, {
      mode: "read_only",
      readable: true,
      writable: false,
    });
    mocks.program.getCommunitySettings.mockResolvedValueOnce(
      settings({ studentRoleMappings: [] }),
    );
    const first = renderPage();
    await screen.findByRole("heading", { name: "Program Chat Room" });
    fireEvent.change(screen.getByLabelText(/Program Title/u), {
      target: { value: "Core edit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update Program" }));
    await waitFor(() => expect(mocks.program.updateProgram).toHaveBeenCalledOnce());
    expect(mocks.program.updateCommunitySettings).not.toHaveBeenCalled();

    first.unmount();
    vi.clearAllMocks();
    mocks.program.getById.mockResolvedValue(program);
    mocks.program.getCommunitySettings.mockResolvedValue(
      enabledSettings().studentRoleMappings.length
        ? { ...enabledSettings(), studentRoleMappings: [] }
        : enabledSettings(),
    );
    mocks.purchase.checkProgramAccess.mockResolvedValue({
      hasAccess: true,
      reason: "admin",
    });
    renderPage();
    await screen.findByRole("heading", { name: "Program Chat Room" });
    fireEvent.change(screen.getByLabelText(/Program Title/u), {
      target: { value: "Blocked core edit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update Program" }));

    expect(
      await screen.findByText(/must remain consistent/u),
    ).toBeInTheDocument();
    expect(mocks.program.updateProgram).not.toHaveBeenCalled();
  });

  it("fails closed while runtime feature configuration is unavailable", async () => {
    Object.assign(mocks.runtime, {
      status: "error",
      mode: "off",
      readable: false,
      writable: false,
    });
    renderPage();

    expect(
      await screen.findByText(/Feature settings are unavailable/u),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Program Title/u), {
      target: { value: "Blocked while unknown" },
    });
    expect(screen.getByRole("button", { name: "Update Program" })).toBeDisabled();
    expect(mocks.program.getCommunitySettings).not.toHaveBeenCalled();
  });
});
