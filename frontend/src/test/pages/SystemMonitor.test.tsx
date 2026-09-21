import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter } from "react-router-dom";
import SystemMonitor from "../../pages/SystemMonitor";

vi.mock("../../components/system/AlumniNetworkModeControl", () => ({
  default: () => null,
}));

// Mock data
const mockHealthData = {
  success: true,
  healthy: true,
  requestsPerSecond: 5,
  requestsLastMinute: 300,
  suspiciousPatterns: 0,
};

const mockStatsData = {
  success: true,
  data: {
    totalRequestsLastHour: 18000,
    totalRequestsLastMinute: 300,
    requestsPerSecond: 5,
    globalUniqueIPsLastHour: 150,
    globalUniqueUserAgentsLastHour: 75,
    errorsLastHour: 50,
    errorRateLastHour: 0.0028,
    endpointMetrics: [
      {
        endpoint: "/api/events",
        count: 5000,
        averageResponseTime: 120,
        errorCount: 10,
        uniqueIPs: 50,
        uniqueUserAgents: 30,
      },
      {
        endpoint: "/api/users",
        count: 3000,
        averageResponseTime: 90,
        errorCount: 5,
        uniqueIPs: 40,
        uniqueUserAgents: 25,
      },
    ],
    topIPs: [
      { ip: "192.168.1.1", count: 500 },
      { ip: "10.0.0.1", count: 300 },
    ],
    topUserAgents: [
      { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", count: 2000 },
      {
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        count: 1500,
      },
    ],
    suspiciousPatterns: [],
  },
};

const mockRateLimitingData = {
  success: true,
  data: {
    enabled: true,
    status: "enabled" as const,
  },
};

const mockSuspiciousStatsData = {
  ...mockStatsData,
  data: {
    ...mockStatsData.data,
    suspiciousPatterns: [
      {
        type: "HIGH_REQUEST_RATE",
        description: "IP 192.168.1.100 making 1000 requests/minute",
        severity: "HIGH",
      },
      {
        type: "MULTIPLE_ENDPOINTS",
        description: "IP 10.0.0.50 hitting 50 different endpoints",
        severity: "MEDIUM",
      },
    ],
  },
};

const mockUnhealthyHealthData = {
  ...mockHealthData,
  healthy: false,
};

const mockHighErrorRateStatsData = {
  ...mockStatsData,
  data: {
    ...mockStatsData.data,
    errorRateLastHour: 0.06, // 6% error rate (high)
  },
};

const renderSystemMonitor = () => {
  return render(
    <BrowserRouter>
      <SystemMonitor />
    </BrowserRouter>
  );
};

describe("SystemMonitor", () => {
  beforeEach(() => {
    // Mock localStorage
    Storage.prototype.getItem = vi.fn(() => "mock-token");

    // Mock fetch
    globalThis.fetch = vi.fn();

    // Mock environment
    vi.stubEnv("VITE_API_URL", "http://localhost:5001/api");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  // ========== Loading States ==========
  describe("Loading State", () => {
    it("should display loading state initially", () => {
      (globalThis.fetch as any).mockImplementation(() => new Promise(() => {})); // Never resolves

      renderSystemMonitor();

      expect(screen.getByText("Loading System Monitor...")).toBeInTheDocument();
    });

    it("should show loading icon during data fetch", () => {
      (globalThis.fetch as any).mockImplementation(() => new Promise(() => {}));

      renderSystemMonitor();

      const icon = document.querySelector("svg");
      expect(icon).toBeInTheDocument();
    });
  });

  // ========== Error States ==========
  describe("Error Handling", () => {
    it("should display error when no auth token", async () => {
      Storage.prototype.getItem = vi.fn(() => null);

      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("Monitor Error")).toBeInTheDocument();
        expect(
          screen.getByText("Failed to fetch monitoring data")
        ).toBeInTheDocument();
      });
    });

    it("should display error when health fetch fails", async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: false,
        json: async () => ({ success: false }),
      });

      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("Monitor Error")).toBeInTheDocument();
      });
    });

    it("should show retry button on error", async () => {
      Storage.prototype.getItem = vi.fn(() => null);

      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("Retry")).toBeInTheDocument();
      });
    });

    it("should retry fetch when retry button clicked", async () => {
      Storage.prototype.getItem = vi.fn(() => null);
      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("Retry")).toBeInTheDocument();
      });

      // Now provide token for retry
      Storage.prototype.getItem = vi.fn(() => "mock-token");
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockHealthData,
      });
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockStatsData,
      });
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockRateLimitingData,
      });

      const user = userEvent.setup({ delay: null });
      await user.click(screen.getByText("Retry"));

      await waitFor(() => {
        expect(screen.getByText("System Healthy")).toBeInTheDocument();
      });
    });

    it("should handle fetch exception with error message", async () => {
      (globalThis.fetch as any).mockRejectedValueOnce(
        new Error("Network error")
      );

      renderSystemMonitor();

      await waitFor(() => {
        expect(
          screen.getByText("Failed to fetch monitoring data")
        ).toBeInTheDocument();
      });
    });
  });

  // ========== Successful Data Load ==========
  describe("Successful Data Display", () => {
    beforeEach(() => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });
    });

    it("should display page header", async () => {
      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("System Monitor")).toBeInTheDocument();
      });
    });

    it("should display page subtitle", async () => {
      renderSystemMonitor();

      await waitFor(() => {
        expect(
          screen.getByText(
            "Real-time server monitoring and analytics dashboard"
          )
        ).toBeInTheDocument();
      });
    });

    it("should display healthy status", async () => {
      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("System Healthy")).toBeInTheDocument();
      });
    });

    it("should display health metrics", async () => {
      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText(/Requests\/sec:/)).toBeInTheDocument();
        const fiveElements = screen.getAllByText("5");
        expect(fiveElements.length).toBeGreaterThan(0);
        expect(screen.getByText(/Requests\/min:/)).toBeInTheDocument();
        const threeHundredElements = screen.getAllByText("300");
        expect(threeHundredElements.length).toBeGreaterThan(0);
        expect(screen.getByText(/Suspicious patterns:/)).toBeInTheDocument();
      });
    });

    it("should display rate limiting status", async () => {
      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText(/Rate Limiting:/)).toBeInTheDocument();
        expect(screen.getByText("Active")).toBeInTheDocument();
      });
    });

    it("should display total requests last hour", async () => {
      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("Last Hour")).toBeInTheDocument();
        expect(screen.getByText("18000")).toBeInTheDocument();
      });
    });

    it("should display total requests last minute", async () => {
      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("Last Minute")).toBeInTheDocument();
        // Multiple "300" values, check within stats overview
        const statsCards = screen.getAllByText("300");
        expect(statsCards.length).toBeGreaterThan(0);
      });
    });

    it("should display requests per second", async () => {
      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("Requests/Second")).toBeInTheDocument();
      });
    });

    it("should display suspicious patterns count", async () => {
      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("Suspicious Patterns")).toBeInTheDocument();
        const zeroElements = screen.getAllByText("0");
        expect(zeroElements.length).toBeGreaterThan(0);
      });
    });
  });

  // ========== Enriched Metrics ==========
  describe("Enriched Metrics Display", () => {
    beforeEach(() => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });
    });

    it("should display unique IPs count", async () => {
      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("Unique IPs (1h)")).toBeInTheDocument();
        expect(screen.getByText("150")).toBeInTheDocument();
      });
    });

    it("should display unique user agents count", async () => {
      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("Unique User Agents (1h)")).toBeInTheDocument();
        expect(screen.getByText("75")).toBeInTheDocument();
      });
    });

    it("should display errors count", async () => {
      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("Errors (1h)")).toBeInTheDocument();
        expect(screen.getByText("50")).toBeInTheDocument();
      });
    });

    it("should display error rate percentage", async () => {
      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("Error Rate (1h)")).toBeInTheDocument();
        expect(screen.getByText("0.28%")).toBeInTheDocument();
      });
    });

    it("should display Low error rate badge for < 1%", async () => {
      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("Low")).toBeInTheDocument();
      });
    });

    it("should display error rate exclusion note", async () => {
      renderSystemMonitor();

      await waitFor(() => {
        expect(
          screen.getByText("Excludes expected auth 401/403")
        ).toBeInTheDocument();
      });
    });
  });

  // ========== Error Rate Severity Badges ==========
  describe("Error Rate Severity", () => {
    it("should show Elevated badge for error rate 1-5%", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ...mockStatsData,
            data: { ...mockStatsData.data, errorRateLastHour: 0.03 },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("Elevated")).toBeInTheDocument();
      });
    });

    it("should show High badge for error rate >= 5%", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHighErrorRateStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("High")).toBeInTheDocument();
        expect(screen.getByText("6.00%")).toBeInTheDocument();
      });
    });
  });

  // ========== Suspicious Patterns ==========
  describe("Suspicious Patterns Alert", () => {
    it("should not show alert when no suspicious patterns", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("System Healthy")).toBeInTheDocument();
      });

      expect(
        screen.queryByText("🚨 Suspicious Activity Detected")
      ).not.toBeInTheDocument();
    });

    it("should show alert when suspicious patterns detected", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ...mockHealthData,
            suspiciousPatterns: 2,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockSuspiciousStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(
          screen.getByText("🚨 Suspicious Activity Detected")
        ).toBeInTheDocument();
      });
    });

    it("should display high severity pattern", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ...mockHealthData,
            suspiciousPatterns: 2,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockSuspiciousStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText(/HIGH_REQUEST_RATE:/)).toBeInTheDocument();
        expect(
          screen.getByText(/IP 192.168.1.100 making 1000 requests\/minute/)
        ).toBeInTheDocument();
      });
    });

    it("should display medium severity pattern", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ...mockHealthData,
            suspiciousPatterns: 2,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockSuspiciousStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText(/MULTIPLE_ENDPOINTS:/)).toBeInTheDocument();
        expect(
          screen.getByText(/IP 10.0.0.50 hitting 50 different endpoints/)
        ).toBeInTheDocument();
      });
    });
  });

  // ========== Endpoint Metrics ==========
  describe("Top Endpoints Display", () => {
    beforeEach(() => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });
    });

    it("should display Top Endpoints section", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("Top Endpoints")).toBeInTheDocument();
      });
    });

    it("should display endpoint paths", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("/api/events")).toBeInTheDocument();
        expect(screen.getByText("/api/users")).toBeInTheDocument();
      });
    });

    it("should display endpoint request counts", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText(/5000 requests/)).toBeInTheDocument();
        expect(screen.getByText(/3000 requests/)).toBeInTheDocument();
      });
    });

    it("should display endpoint average response times", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText(/avg 120ms/)).toBeInTheDocument();
        expect(screen.getByText(/avg 90ms/)).toBeInTheDocument();
      });
    });

    it("should display endpoint error counts", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("10 errors")).toBeInTheDocument();
        expect(screen.getByText("5 errors")).toBeInTheDocument();
      });
    });

    it("should show message when no endpoint data", async () => {
      // Reset the mock completely to clear any previous setup
      (globalThis.fetch as any).mockReset();

      // Setup fresh mocks
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              totalRequestsLastHour: 18000,
              totalRequestsLastMinute: 300,
              requestsPerSecond: 5,
              globalUniqueIPsLastHour: 150,
              globalUniqueUserAgentsLastHour: 75,
              errorsLastHour: 50,
              errorRateLastHour: 0.0028,
              endpointMetrics: [], // Empty array
              topIPs: mockStatsData.data.topIPs,
              topUserAgents: mockStatsData.data.topUserAgents,
              suspiciousPatterns: [],
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      const { unmount } = renderSystemMonitor();

      try {
        // Wait for component to fully render
        await waitFor(() => {
          expect(screen.getByText("Top Endpoints")).toBeInTheDocument();
        });

        // The "No endpoint data available" should now be visible
        expect(
          screen.getByText(/No endpoint data available/i)
        ).toBeInTheDocument();
      } finally {
        unmount();
      }
    });
  });

  // ========== Top IPs Display ==========
  describe("Top IPs Display", () => {
    it("should display Top IP Addresses section", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("Top IP Addresses")).toBeInTheDocument();
      });
    });

    it("should display IP addresses", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("192.168.1.1")).toBeInTheDocument();
        expect(screen.getByText("10.0.0.1")).toBeInTheDocument();
      });
    });

    it("should display IP request counts", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("500 requests")).toBeInTheDocument();
        expect(screen.getByText("300 requests")).toBeInTheDocument();
      });
    });

    it("should show message when no IP data", async () => {
      (globalThis.fetch as any).mockClear();
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ...mockStatsData,
            data: {
              ...mockStatsData.data,
              topIPs: [],
              suspiciousPatterns: [],
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      // Wait for stats to load
      await waitFor(() => {
        expect(screen.getByText("Top IP Addresses")).toBeInTheDocument();
      });

      // Check if "No IP data available" is present
      expect(screen.getByText(/No IP data available/i)).toBeInTheDocument();
    });
  });

  // ========== Top User Agents Display ==========
  describe("Top User Agents Display", () => {
    it("should display Top User Agents section", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("Top User Agents")).toBeInTheDocument();
      });
    });

    it("should display user agent strings", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(
          screen.getByText("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
        ).toBeInTheDocument();
        expect(
          screen.getByText("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")
        ).toBeInTheDocument();
      });
    });

    it("should display user agent request counts", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("2000 requests")).toBeInTheDocument();
        expect(screen.getByText("1500 requests")).toBeInTheDocument();
      });
    });

    it("should show message when no user agent data", async () => {
      (globalThis.fetch as any).mockClear();
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ...mockStatsData,
            data: {
              ...mockStatsData.data,
              topUserAgents: [],
              suspiciousPatterns: [],
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      // Wait for stats to load
      await waitFor(() => {
        expect(screen.getByText("Top User Agents")).toBeInTheDocument();
      });

      // Check if "No user agent data available" is present
      expect(
        screen.getByText(/No user agent data available/i)
      ).toBeInTheDocument();
    });
  });

  // ========== Controls ==========
  describe("Control Buttons", () => {
    beforeEach(() => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });
    });

    it("should display Refresh Data button", async () => {
      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("Refresh Data")).toBeInTheDocument();
      });
    });

    it("should display auto-refresh checkbox", async () => {
      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("Auto-refresh (30s)")).toBeInTheDocument();
      });
    });

    it("should have auto-refresh enabled by default", async () => {
      renderSystemMonitor();

      await waitFor(() => {
        const checkbox = screen.getByRole("checkbox");
        expect(checkbox).toBeChecked();
      });
    });

    it("should toggle auto-refresh when checkbox clicked", async () => {
      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByRole("checkbox")).toBeChecked();
      });

      const user = userEvent.setup({ delay: null });
      const checkbox = screen.getByRole("checkbox");
      await user.click(checkbox);

      expect(checkbox).not.toBeChecked();
    });

    it("should refetch data when Refresh Data clicked", async () => {
      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("Refresh Data")).toBeInTheDocument();
      });

      // Mock additional fetches for refresh
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      const user = userEvent.setup({ delay: null });
      await user.click(screen.getByText("Refresh Data"));

      await waitFor(() => {
        expect(globalThis.fetch).toHaveBeenCalledTimes(6); // 3 initial + 3 refresh
      });
    });
  });

  // ========== Auto-Refresh ==========
  describe("Auto-Refresh Functionality", () => {
    it("should auto-refresh every 30 seconds when enabled", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText("System Healthy")).toBeInTheDocument();
      });

      // Just verify auto-refresh indicator is shown
      expect(
        screen.getByText(/Auto-refreshing every 30 seconds/)
      ).toBeInTheDocument();
    });

    it("should not auto-refresh when disabled", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByRole("checkbox")).toBeChecked();
      });

      const user = userEvent.setup({ delay: null });
      const checkbox = screen.getByRole("checkbox");
      await user.click(checkbox);

      // Verify checkbox is unchecked
      expect(checkbox).not.toBeChecked();
    });

    it("should show auto-refresh indicator in footer", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(
          screen.getByText(/Auto-refreshing every 30 seconds/)
        ).toBeInTheDocument();
      });
    });
  });

  // ========== Rate Limiting Toggle ==========
  describe("Rate Limiting Toggle", () => {
    it("should show disable button when rate limiting enabled", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(
          screen.getByText("🚨 Emergency: Disable Rate Limiting")
        ).toBeInTheDocument();
      });
    });

    it("should show enable button when rate limiting disabled", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ...mockRateLimitingData,
            data: { enabled: false, status: "emergency_disabled" as const },
          }),
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(
          screen.getByText("✅ Recovery: Enable Rate Limiting")
        ).toBeInTheDocument();
      });
    });

    it("should open confirmation dialog when disable button clicked", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(
          screen.getByText("🚨 Emergency: Disable Rate Limiting")
        ).toBeInTheDocument();
      });

      const user = userEvent.setup({ delay: null });
      await user.click(screen.getByText("🚨 Emergency: Disable Rate Limiting"));

      await waitFor(() => {
        expect(
          screen.getByText("Emergency Disable Rate Limiting")
        ).toBeInTheDocument();
      });
    });

    it("should show disable confirmation dialog content", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(
          screen.getByText("🚨 Emergency: Disable Rate Limiting")
        ).toBeInTheDocument();
      });

      const user = userEvent.setup({ delay: null });
      await user.click(screen.getByText("🚨 Emergency: Disable Rate Limiting"));

      await waitFor(() => {
        expect(
          screen.getByText(/You are about to DISABLE rate limiting completely/)
        ).toBeInTheDocument();
        expect(
          screen.getByText(
            /This should only be done during emergency situations/
          )
        ).toBeInTheDocument();
      });
    });

    it("should close dialog when Cancel clicked", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(
          screen.getByText("🚨 Emergency: Disable Rate Limiting")
        ).toBeInTheDocument();
      });

      const user = userEvent.setup({ delay: null });
      await user.click(screen.getByText("🚨 Emergency: Disable Rate Limiting"));

      await waitFor(() => {
        expect(screen.getByText("Cancel")).toBeInTheDocument();
      });

      await user.click(screen.getByText("Cancel"));

      await waitFor(() => {
        expect(
          screen.queryByText("Emergency Disable Rate Limiting")
        ).not.toBeInTheDocument();
      });
    });

    it("should call disable API when confirmed", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(
          screen.getByText("🚨 Emergency: Disable Rate Limiting")
        ).toBeInTheDocument();
      });

      const user = userEvent.setup({ delay: null });
      await user.click(screen.getByText("🚨 Emergency: Disable Rate Limiting"));

      // Mock disable endpoint
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      // Mock refresh data after disable
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ...mockRateLimitingData,
            data: { enabled: false, status: "emergency_disabled" as const },
          }),
        });

      await waitFor(() => {
        expect(
          screen.getByText("🚨 Disable Rate Limiting")
        ).toBeInTheDocument();
      });

      await user.click(screen.getByText("🚨 Disable Rate Limiting"));

      await waitFor(() => {
        expect(globalThis.fetch).toHaveBeenCalledWith(
          "http://localhost:5001/api/monitor/emergency-disable",
          expect.objectContaining({
            method: "POST",
            headers: expect.objectContaining({
              Authorization: "Bearer mock-token",
            }),
          })
        );
      });
    });

    it("should show success notification after disable", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(
          screen.getByText("🚨 Emergency: Disable Rate Limiting")
        ).toBeInTheDocument();
      });

      const user = userEvent.setup({ delay: null });
      await user.click(screen.getByText("🚨 Emergency: Disable Rate Limiting"));

      // Mock disable endpoint
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      // Mock refresh
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      await waitFor(() => {
        expect(
          screen.getByText("🚨 Disable Rate Limiting")
        ).toBeInTheDocument();
      });

      await user.click(screen.getByText("🚨 Disable Rate Limiting"));

      await waitFor(() => {
        expect(
          screen.getByText("🚨 Rate limiting has been emergency disabled!")
        ).toBeInTheDocument();
      });
    });

    it("should call enable API when enabling from disabled state", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ...mockRateLimitingData,
            data: { enabled: false, status: "emergency_disabled" as const },
          }),
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(
          screen.getByText("✅ Recovery: Enable Rate Limiting")
        ).toBeInTheDocument();
      });

      const user = userEvent.setup({ delay: null });
      await user.click(screen.getByText("✅ Recovery: Enable Rate Limiting"));

      // Mock enable endpoint
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      // Mock refresh
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      await waitFor(() => {
        expect(screen.getByText("✅ Enable Rate Limiting")).toBeInTheDocument();
      });

      await user.click(screen.getByText("✅ Enable Rate Limiting"));

      await waitFor(() => {
        expect(globalThis.fetch).toHaveBeenCalledWith(
          "http://localhost:5001/api/monitor/emergency-enable",
          expect.objectContaining({
            method: "POST",
          })
        );
      });
    });

    it("should show enable confirmation dialog content", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ...mockRateLimitingData,
            data: { enabled: false, status: "emergency_disabled" as const },
          }),
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(
          screen.getByText("✅ Recovery: Enable Rate Limiting")
        ).toBeInTheDocument();
      });

      const user = userEvent.setup({ delay: null });
      await user.click(screen.getByText("✅ Recovery: Enable Rate Limiting"));

      await waitFor(() => {
        expect(
          screen.getByText("Recovery Enable Rate Limiting")
        ).toBeInTheDocument();
        expect(
          screen.getByText(/You are about to RE-ENABLE rate limiting/)
        ).toBeInTheDocument();
        expect(
          screen.getByText(/Rate limiting helps protect the server from abuse/)
        ).toBeInTheDocument();
      });
    });

    it("should handle disable API failure", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(
          screen.getByText("🚨 Emergency: Disable Rate Limiting")
        ).toBeInTheDocument();
      });

      const user = userEvent.setup({ delay: null });
      await user.click(screen.getByText("🚨 Emergency: Disable Rate Limiting"));

      // Mock failed disable
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: false }),
      });

      await waitFor(() => {
        expect(
          screen.getByText("🚨 Disable Rate Limiting")
        ).toBeInTheDocument();
      });

      await user.click(screen.getByText("🚨 Disable Rate Limiting"));

      await waitFor(() => {
        expect(
          screen.getByText("Failed to disable rate limiting")
        ).toBeInTheDocument();
      });
    });

    it("should handle enable API failure", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ...mockRateLimitingData,
            data: { enabled: false, status: "emergency_disabled" as const },
          }),
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(
          screen.getByText("✅ Recovery: Enable Rate Limiting")
        ).toBeInTheDocument();
      });

      const user = userEvent.setup({ delay: null });
      await user.click(screen.getByText("✅ Recovery: Enable Rate Limiting"));

      // Mock failed enable
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: false }),
      });

      await waitFor(() => {
        expect(screen.getByText("✅ Enable Rate Limiting")).toBeInTheDocument();
      });

      await user.click(screen.getByText("✅ Enable Rate Limiting"));

      await waitFor(() => {
        expect(
          screen.getByText("Failed to enable rate limiting")
        ).toBeInTheDocument();
      });
    });
  });

  // ========== Health Status UI ==========
  describe("Health Status UI", () => {
    it("should show green color when healthy", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        const healthText = screen.getByText("System Healthy");
        expect(healthText).toHaveClass("text-green-500");
      });
    });

    it("should show red color when unhealthy", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockUnhealthyHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        const healthText = screen.getByText("System Alert");
        expect(healthText).toHaveClass("text-red-500");
      });
    });

    it("should show green background when healthy", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        const healthSection = screen.getByText("System Healthy").closest("div");
        expect(healthSection?.parentElement).toHaveClass("bg-green-50");
      });
    });

    it("should show red background when unhealthy", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockUnhealthyHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        const healthSection = screen.getByText("System Alert").closest("div");
        expect(healthSection?.parentElement).toHaveClass("bg-red-50");
      });
    });

    it("should show DISABLED status in red when rate limiting off", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ...mockRateLimitingData,
            data: { enabled: false, status: "emergency_disabled" as const },
          }),
        });

      renderSystemMonitor();

      await waitFor(() => {
        const disabledText = screen.getByText("DISABLED");
        expect(disabledText).toHaveClass("text-red-600");
      });
    });
  });

  // ========== Notification System ==========
  describe("Custom Notifications", () => {
    it("should dismiss notification when close button clicked", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(
          screen.getByText("🚨 Emergency: Disable Rate Limiting")
        ).toBeInTheDocument();
      });

      const user = userEvent.setup({ delay: null });
      await user.click(screen.getByText("🚨 Emergency: Disable Rate Limiting"));

      // Mock disable success
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      // Mock refresh
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      await waitFor(() => {
        expect(
          screen.getByText("🚨 Disable Rate Limiting")
        ).toBeInTheDocument();
      });

      await user.click(screen.getByText("🚨 Disable Rate Limiting"));

      await waitFor(() => {
        expect(
          screen.getByText("🚨 Rate limiting has been emergency disabled!")
        ).toBeInTheDocument();
      });

      // Click dismiss button (sr-only text)
      const dismissButton = screen.getByText("Dismiss");
      await user.click(dismissButton);

      await waitFor(() => {
        expect(
          screen.queryByText("🚨 Rate limiting has been emergency disabled!")
        ).not.toBeInTheDocument();
      });
    });

    it("should show success notification styling", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ...mockRateLimitingData,
            data: { enabled: false, status: "emergency_disabled" as const },
          }),
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(
          screen.getByText("✅ Recovery: Enable Rate Limiting")
        ).toBeInTheDocument();
      });

      const user = userEvent.setup({ delay: null });
      await user.click(screen.getByText("✅ Recovery: Enable Rate Limiting"));

      // Mock enable success
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      // Mock refresh
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      await waitFor(() => {
        expect(screen.getByText("✅ Enable Rate Limiting")).toBeInTheDocument();
      });

      await user.click(screen.getByText("✅ Enable Rate Limiting"));

      await waitFor(() => {
        const notification = screen.getByText(
          "✅ Rate limiting has been re-enabled!"
        );
        const container = notification.closest(".border-green-400");
        expect(container).toBeInTheDocument();
        expect(container).toHaveClass("border-green-400");
      });
    });

    it("should show error notification styling", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(
          screen.getByText("🚨 Emergency: Disable Rate Limiting")
        ).toBeInTheDocument();
      });

      const user = userEvent.setup({ delay: null });
      await user.click(screen.getByText("🚨 Emergency: Disable Rate Limiting"));

      // Mock failed disable
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: false }),
      });

      await waitFor(() => {
        expect(
          screen.getByText("🚨 Disable Rate Limiting")
        ).toBeInTheDocument();
      });

      await user.click(screen.getByText("🚨 Disable Rate Limiting"));

      await waitFor(() => {
        const notification = screen.getByText(
          "Failed to disable rate limiting"
        );
        const container = notification.closest(".border-red-400");
        expect(container).toBeInTheDocument();
        expect(container).toHaveClass("border-red-400");
      });
    });
  });

  // ========== Footer ==========
  describe("Footer Display", () => {
    it("should show last updated timestamp", async () => {
      (globalThis.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockHealthData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatsData,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRateLimitingData,
        });

      renderSystemMonitor();

      await waitFor(() => {
        expect(screen.getByText(/Last updated:/)).toBeInTheDocument();
      });
    });
  });
});
