import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import PrivacyDataUse from "../../pages/PrivacyDataUse";

describe("PrivacyDataUse", () => {
  it("publishes the approved audience, choices, and retention summary", () => {
    render(
      <MemoryRouter>
        <PrivacyDataUse />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", { name: "Privacy & Data Use" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/active, verified @Cloud ERP members/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/later changes saved to those public fields also appear/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/private draft while the account exists/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/removed from the primary database within 30 days/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Muting a room stops its optional notifications/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Unenrolling ends access to new messages/i),
    ).toBeInTheDocument();

    const table = screen.getByRole("table");
    expect(within(table).queryByText(/roster|invitation|import raw rows/i)).not.toBeInTheDocument();
    expect(within(table).getByRole("rowheader", { name: "Audit log" }).parentElement).toHaveTextContent("3 months");
    expect(
      within(table).getByRole("rowheader", { name: "Push subscription" }),
    ).toBeInTheDocument();
    expect(
      within(table).getByRole("rowheader", { name: "Notification outbox" }),
    ).toBeInTheDocument();
  });
});
