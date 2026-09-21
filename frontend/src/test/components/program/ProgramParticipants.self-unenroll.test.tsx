import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ProgramParticipants } from "../../../components/program/ProgramParticipants";

const mockCurrentUser = {
  id: "user-1",
  role: "Participant",
};

vi.mock("../../../contexts/AuthContext", () => ({
  useAuth: () => ({
    currentUser: mockCurrentUser,
  }),
}));

vi.mock("../../../contexts/NotificationModalContext", () => ({
  useToastReplacement: () => ({
    success: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../../../hooks/useAvatarUpdates", () => ({
  useAvatarUpdates: () => 0,
}));

vi.mock("../../../services/api", () => ({
  apiClient: {
    adminEnroll: vi.fn(),
    adminUnenroll: vi.fn(),
  },
  programService: {
    getParticipants: vi.fn(),
    getUnenrollPreview: vi.fn(),
    selfUnenrollProgram: vi.fn(),
  },
}));

const { apiClient, programService } = await import("../../../services/api");

describe("ProgramParticipants self unenroll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCurrentUser.role = "Participant";
    (programService.getParticipants as any).mockResolvedValue({
      classReps: [],
      mentees: [
        {
          user: {
            id: "user-1",
            firstName: "Taylor",
            lastName: "Chen",
            email: "taylor@example.com",
            gender: "female",
          },
          isPaid: true,
          enrollmentDate: new Date().toISOString(),
        },
      ],
    });
    (programService.getUnenrollPreview as any).mockResolvedValue({
      enrollmentType: "mentee",
      isPaid: true,
      refundEligible: false,
      requiresApproval: false,
      refundAmount: 0,
      refundWindowExpired: true,
    });
    (programService.selfUnenrollProgram as any).mockResolvedValue({
      refundStatus: "not_eligible",
      enrollmentType: "mentee",
    });
  });

  it("requires a final confirmation before self-unenrolling", async () => {
    render(
      <MemoryRouter>
        <ProgramParticipants
          programId="program-1"
          program={{ id: "program-1", mentors: [] }}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("Taylor Chen")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /^unenroll$/i }));

    await waitFor(() => {
      expect(screen.getByText("Unenroll Without Refund")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByText("Final Confirmation")).toBeInTheDocument();
    });
    expect(programService.selfUnenrollProgram).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /yes, unenroll/i }));

    await waitFor(() => {
      expect(programService.selfUnenrollProgram).toHaveBeenCalledWith(
        "program-1",
      );
    });
  });

  it("refreshes Program-dependent UI after an administrator enrolls", async () => {
    mockCurrentUser.role = "Administrator";
    (programService.getParticipants as any).mockResolvedValue({
      classReps: [],
      mentees: [],
    });
    const onEnrollmentChanged = vi.fn();

    render(
      <MemoryRouter>
        <ProgramParticipants
          onEnrollmentChanged={onEnrollmentChanged}
          programId="program-1"
          program={{ id: "program-1", mentors: [] }}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Enroll as Mentee" }),
    );

    await waitFor(() => {
      expect(apiClient.adminEnroll).toHaveBeenCalledWith("program-1", "mentee");
      expect(onEnrollmentChanged).toHaveBeenCalledOnce();
    });
  });
});
