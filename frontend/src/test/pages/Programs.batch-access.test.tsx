import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Programs from "../../pages/Programs";

const mocks = vi.hoisted(() => ({
  listPrograms: vi.fn(),
  listMemberships: vi.fn(),
  checkProgramAccess: vi.fn(),
  checkProgramsAccess: vi.fn(),
}));

vi.mock("../../services/api", () => ({
  annualMembershipService: { list: mocks.listMemberships },
  programService: { list: mocks.listPrograms },
  purchaseService: {
    checkProgramAccess: mocks.checkProgramAccess,
    checkProgramsAccess: mocks.checkProgramsAccess,
  },
}));

vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({
    currentUser: {
      id: "user-1",
      firstName: "Test",
      lastName: "User",
      role: "Participant",
    },
  }),
}));

describe("Programs access loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listMemberships.mockResolvedValue([]);
    mocks.listPrograms.mockResolvedValue([
      {
        id: "program-1",
        title: "Program One",
        programType: "Webinar",
        isFree: false,
        period: { startYear: "2025", startMonth: "01" },
      },
      {
        id: "program-2",
        title: "Program Two",
        programType: "NextGen",
        isFree: false,
        period: { startYear: "2026", startMonth: "01" },
      },
    ]);
    mocks.checkProgramsAccess.mockResolvedValue({
      "program-1": { hasAccess: true, reason: "purchased" },
      "program-2": { hasAccess: false, reason: "not_purchased" },
    });
  });

  it("loads every card's access state with one batch request", async () => {
    render(
      <MemoryRouter>
        <Programs />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Program One")).toBeInTheDocument();
    expect(await screen.findByText("Program Two")).toBeInTheDocument();

    await waitFor(() => {
      expect(mocks.checkProgramsAccess).toHaveBeenCalledTimes(1);
      expect(mocks.checkProgramsAccess).toHaveBeenCalledWith([
        "program-1",
        "program-2",
      ]);
    });
    expect(mocks.checkProgramAccess).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Show Controls" }));
    fireEvent.change(screen.getByLabelText("Sort by Start Time:"), {
      target: { value: "desc" },
    });

    await waitFor(() => {
      expect(mocks.checkProgramsAccess).toHaveBeenCalledTimes(2);
      expect(mocks.checkProgramsAccess).toHaveBeenLastCalledWith([
        "program-2",
        "program-1",
      ]);
    });
  });

  it("shows a retry action when access loading fails", async () => {
    mocks.checkProgramsAccess
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockResolvedValueOnce({
        "program-1": { hasAccess: true, reason: "purchased" },
        "program-2": { hasAccess: false, reason: "not_purchased" },
      });

    render(
      <MemoryRouter>
        <Programs />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText("We couldn't load your enrollment status."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(mocks.checkProgramsAccess).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});
