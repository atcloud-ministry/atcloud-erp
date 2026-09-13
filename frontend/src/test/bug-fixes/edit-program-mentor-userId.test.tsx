/**
 * Bug Fix Test: Edit Program mentor payload userId
 *
 * Issue: Adding a mentor could submit mentors with a missing userId, causing
 * the backend to reject the update with "mentors.0.userId: Path `userId` is required."
 *
 * Fix: Build the mentor payload from the purpose-scoped picker ID and send only
 * the canonical userId to the backend.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { NotificationProvider } from "../../contexts/NotificationModalContext";
import EditProgram from "../../pages/EditProgram";

vi.mock("../../contexts/RuntimeConfigContext", () => ({
  useRuntimeConfig: () => ({
    status: "ready",
    config: {
      alumniNetwork: { mode: "off", readable: false, writable: false },
    },
  }),
}));

const mockedProgramService = vi.hoisted(() => ({
  getById: vi.fn(),
  updateProgram: vi.fn(),
}));

const mockedPurchaseService = vi.hoisted(() => ({
  checkProgramAccess: vi.fn(),
}));

const mockedUserOptionsService = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../../services/api", () => ({
  programService: mockedProgramService,
  purchaseService: mockedPurchaseService,
  userOptionsService: mockedUserOptionsService,
  fileService: {
    uploadGenericImage: vi.fn(),
  },
}));

vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({
    currentUser: {
      id: "admin-user-id",
      firstName: "Admin",
      lastName: "User",
      email: "admin@example.com",
      role: "Super Admin",
      roleInAtCloud: "Admin",
      gender: "male",
      avatar: null,
      phone: "555-0100",
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
      earlyBirdDiscount: {
        isValid: true,
        message: "",
        color: "text-green-600",
      },
      earlyBirdDeadline: {
        isValid: true,
        message: "",
        color: "text-green-600",
      },
      period: { isValid: true, message: "", color: "text-green-600" },
      mentors: { isValid: true, message: "", color: "text-green-600" },
      startYear: { isValid: true, message: "", color: "text-green-600" },
      startMonth: { isValid: true, message: "", color: "text-green-600" },
      endYear: { isValid: true, message: "", color: "text-green-600" },
      endMonth: { isValid: true, message: "", color: "text-green-600" },
    },
    overallStatus: { isValid: true, errorCount: 0 },
  }),
}));

const renderEditProgram = () =>
  render(
    <NotificationProvider>
      <MemoryRouter initialEntries={["/dashboard/programs/program1/edit"]}>
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

describe("Bug Fix: Edit Program mentor userId payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockedProgramService.getById.mockResolvedValue({
      id: "program1",
      title: "Test Mentor Circle Program",
      programType: "EMBA Mentor Circles",
      hostedBy: "@Cloud Marketplace Ministry",
      period: {
        startYear: "2026",
        startMonth: "01",
        endYear: "2026",
        endMonth: "12",
      },
      introduction: "Test introduction",
      flyerUrl: "",
      isFree: true,
      earlyBirdDeadline: "",
      fullPriceTicket: 0,
      classRepDiscount: 0,
      earlyBirdDiscount: 0,
      classRepLimit: 0,
      mentors: [],
    });

    mockedPurchaseService.checkProgramAccess.mockResolvedValue({
      hasAccess: true,
      reason: "admin",
    });

    mockedUserOptionsService.list.mockResolvedValue({
      options: [
        {
          id: "mentor-object-id",
          username: "mentor",
          firstName: "Mentor",
          lastName: "OnlyId",
          role: "Leader",
          roleInAtCloud: "Mentor",
          gender: "female",
          avatar: null,
        },
      ],
      pagination: {
        currentPage: 1,
        totalPages: 1,
        totalOptions: 1,
        hasNext: false,
        hasPrev: false,
      },
    });
  });

  it("maps an added picker option id into mentors[].userId", async () => {
    renderEditProgram();

    await waitFor(() => {
      expect(
        screen.getByDisplayValue("Test Mentor Circle Program"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /add mentor/i }));

    const mentorOption = await screen.findByRole("button", {
      name: /Mentor OnlyId/i,
    });
    fireEvent.click(mentorOption);

    fireEvent.click(screen.getByRole("button", { name: /update program/i }));

    await waitFor(() => {
      expect(mockedProgramService.updateProgram).toHaveBeenCalled();
    });

    const [, payload] = mockedProgramService.updateProgram.mock.calls[0];

    expect(payload.mentors).toHaveLength(1);
    expect(payload.mentors[0]).toEqual({ userId: "mentor-object-id" });
    expect(mockedUserOptionsService.list).toHaveBeenCalledWith(
      expect.objectContaining({
        context: "program-mentor",
        resourceId: "program1",
      }),
    );
  });
});
