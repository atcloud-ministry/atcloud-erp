import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import Analytics from "../../pages/Analytics";
import { analyticsService } from "../../services/api/analytics.api";
import { useUserAnalyticsResource } from "../../hooks/useAnalyticsResources";
import { createRegistrationProfileKpis } from "../fixtures/registrationProfileKpis";

const originalCreateObjectURL = window.URL.createObjectURL;
const originalRevokeObjectURL = window.URL.revokeObjectURL;

const notification = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({ currentUser: { id: "admin", role: "Administrator" } }),
}));

vi.mock("../../contexts/NotificationModalContext", () => ({
  useToastReplacement: () => notification,
}));

vi.mock("../../hooks/useAnalyticsResources", () => {
  const emptyResource = () => ({
    data: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
  return {
    useAnalyticsOverviewResource: emptyResource,
    useEventAnalyticsResource: emptyResource,
    useUserAnalyticsResource: vi.fn(emptyResource),
    useAttendanceAnalyticsResource: emptyResource,
    useProgramAnalyticsResource: emptyResource,
    useFinancialSummaryResource: emptyResource,
    useDonationAnalyticsResource: emptyResource,
  };
});

describe("Analytics profile KPI export", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    notification.success.mockReset();
    notification.error.mockReset();
    if (originalCreateObjectURL) {
      Object.defineProperty(window.URL, "createObjectURL", {
        configurable: true,
        value: originalCreateObjectURL,
      });
    } else {
      Reflect.deleteProperty(window.URL, "createObjectURL");
    }
    if (originalRevokeObjectURL) {
      Object.defineProperty(window.URL, "revokeObjectURL", {
        configurable: true,
        value: originalRevokeObjectURL,
      });
    } else {
      Reflect.deleteProperty(window.URL, "revokeObjectURL");
    }
  });

  it("downloads the dedicated aggregate-only Excel export", async () => {
    vi.mocked(useUserAnalyticsResource).mockReturnValue({
      data: {
        registrationProfileKpis: createRegistrationProfileKpis(),
      } as never,
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    const blob = new Blob(["workbook"]);
    vi.spyOn(analyticsService, "exportRegistrationProfileKpis").mockResolvedValue(
      blob,
    );
    Object.defineProperty(window.URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:profile-kpis"),
    });
    Object.defineProperty(window.URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    render(
      <MemoryRouter initialEntries={["/analytics?tab=people"]}>
        <Analytics />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Export Data" }));
    expect(
      screen.getByRole("button", { name: /Export Profile KPIs \(Excel\)/i }),
    ).toHaveTextContent(
      "Only aggregate groups meeting the privacy threshold",
    );
    expect(
      screen.getByRole("button", { name: /Export All \(JSON\)/i }),
    ).toHaveTextContent("Authorized operational data");

    fireEvent.click(
      screen.getByRole("button", { name: /Export Profile KPIs \(Excel\)/i }),
    );

    await waitFor(() => {
      expect(
        analyticsService.exportRegistrationProfileKpis,
      ).toHaveBeenCalledWith("xlsx");
    });
    expect(anchorClick).toHaveBeenCalledOnce();
    expect(
      (anchorClick.mock.instances[0] as unknown as HTMLAnchorElement).download,
    ).toBe("registration-profile-kpis.xlsx");
    expect(window.URL.createObjectURL).toHaveBeenCalledWith(blob);
    expect(window.URL.revokeObjectURL).toHaveBeenCalledWith(
      "blob:profile-kpis",
    );
    expect(notification.success).toHaveBeenCalledWith(
      "Profile KPIs exported successfully",
    );
    expect(notification.error).not.toHaveBeenCalled();
  });

  it("hides the dedicated export until the backend advertises KPI support", () => {
    vi.mocked(useUserAnalyticsResource).mockReturnValue({
      data: {} as never,
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(
      <MemoryRouter initialEntries={["/analytics?tab=people"]}>
        <Analytics />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Export Data" }));
    expect(
      screen.queryByRole("button", {
        name: /Export Profile KPIs \(Excel\)/i,
      }),
    ).not.toBeInTheDocument();
  });
});
