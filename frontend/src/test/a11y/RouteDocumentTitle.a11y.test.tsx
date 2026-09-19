import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import RouteDocumentTitle, {
  routeDocumentTitle,
} from "../../components/common/RouteDocumentTitle";

describe("route document titles", () => {
  it("provides descriptive titles for Alumni routes and verification links", () => {
    expect(routeDocumentTitle("/dashboard/community/alumni")).toBe(
      "Alumni Directory | @Cloud ERP",
    );
    expect(routeDocumentTitle("/dashboard/chat-rooms/507f1f77bcf86cd799439011")).toBe(
      "Chat Room | @Cloud ERP",
    );
    expect(routeDocumentTitle("/", "?verifyEmailToken=secret")).toBe(
      "Email Verification | @Cloud ERP",
    );
  });

  it("updates the title after client-side navigation", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/privacy"]}>
        <RouteDocumentTitle />
        <Routes>
          <Route
            path="/privacy"
            element={<Link to="/dashboard/chat-rooms">Open Chat Rooms</Link>}
          />
          <Route path="/dashboard/chat-rooms" element={<div>Rooms</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(document.title).toBe("Privacy & Data Use | @Cloud ERP"),
    );
    await user.click(screen.getByRole("link", { name: "Open Chat Rooms" }));
    await waitFor(() => expect(document.title).toBe("Chat Rooms | @Cloud ERP"));
  });
});
