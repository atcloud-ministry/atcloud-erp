import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
const navigateMock = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});
import { useLogin } from "../../hooks/useLogin";

// Mock auth context
vi.mock("../../hooks/useAuth", () => {
  return {
    useAuth: () => ({
      login: vi.fn().mockResolvedValue({ success: true }),
    }),
  };
});

// Mock notification system
vi.mock("../../contexts/NotificationModalContext", () => ({
  useToastReplacement: () => ({
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  }),
}));

describe("useLogin navigation ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it("leaves the stored return URL for the Login page to consume", async () => {
    const returnUrl =
      "/dashboard/chat-rooms/507f1f77bcf86cd799439011?source=session-expired#latest";
    sessionStorage.setItem("returnUrl", returnUrl);
    const { result } = renderHook(() => useLogin());

    await act(async () => {
      await result.current.handleLogin({
        emailOrUsername: "user@example.com",
        password: "pass",
      } as any);
    });

    expect(sessionStorage.getItem("returnUrl")).toBe(returnUrl);
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
