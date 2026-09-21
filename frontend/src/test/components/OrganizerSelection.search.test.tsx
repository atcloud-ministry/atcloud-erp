import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import OrganizerSelection from "../../components/events/OrganizerSelection";
import { NotificationProvider } from "../../contexts/NotificationModalContext";
import { AuthProvider } from "../../contexts/AuthContext";

const listOptionsMock = vi.fn();
vi.mock("../../services/api", async () => {
  const actual = await vi.importActual<typeof import("../../services/api")>(
    "../../services/api"
  );
  return {
    ...actual,
    userOptionsService: {
      list: (...args: unknown[]) => listOptionsMock(...args),
    },
  };
});

listOptionsMock.mockImplementation(async (params: { q?: string }) => {
  if (params.q?.toLowerCase().includes("zoe")) {
          return {
            options: [
              {
                id: "u42",
                username: "zoe",
                firstName: "Zoe",
                lastName: "Admin",
                role: "Administrator",
                gender: "female",
                avatar: null,
                roleInAtCloud: null,
              },
            ],
            pagination: {
              currentPage: 1,
              totalPages: 1,
              totalOptions: 1,
              hasNext: false,
              hasPrev: false,
            },
          };
  }
  return {
    options: [],
    pagination: {
      currentPage: 1,
      totalPages: 0,
      totalOptions: 0,
      hasNext: false,
      hasPrev: false,
    },
  };
});

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <AuthProvider>
    <NotificationProvider>{children}</NotificationProvider>
  </AuthProvider>
);

describe("OrganizerSelection — search all authorized users", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows search box and allows selecting a user beyond initial 20 via search", async () => {
    const mainOrganizer = {
      id: "u1",
      firstName: "Main",
      lastName: "Owner",
      systemAuthorizationLevel: "Administrator",
      gender: "male" as const,
      avatar: null,
    };

    const onChange = vi.fn();

    render(
      <Wrapper>
        <OrganizerSelection
          mainOrganizer={mainOrganizer as any}
          selectedOrganizers={[]}
          onOrganizersChange={onChange}
          context="program-mentor"
          resourceId="program-123"
        />
      </Wrapper>
    );

    // Open dropdown
    fireEvent.click(screen.getByText(/add co-organizer/i));

    // Type in the search box
    const input = await screen.findByPlaceholderText(/name or username/i);
    fireEvent.change(input, { target: { value: "Zoe" } });

    // Wait for search result to appear and click it
    const result = await screen.findByText(/Zoe Admin/i);
    fireEvent.click(result);

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
      const arg = onChange.mock.calls[0][0][0];
      expect(arg).not.toHaveProperty("email");
      expect(arg.systemAuthorizationLevel).toBe("Administrator");
      expect(listOptionsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          context: "program-mentor",
          resourceId: "program-123",
          q: "Zoe",
        }),
      );
    });
  });
});
