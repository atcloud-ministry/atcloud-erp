import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AuthInitializationError from "../../components/common/AuthInitializationError";

describe("AuthInitializationError", () => {
  it("presents a recoverable session check without asking the user to sign in again", () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    render(
      <AuthInitializationError
        message="Check your connection and try again."
        onRetry={retry}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Unable to verify your session" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
