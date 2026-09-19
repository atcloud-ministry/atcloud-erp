import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ChatComposer from "../../../components/chat/ChatComposer";

describe("ChatComposer", () => {
  it("sends trimmed content with Enter and preserves Shift+Enter", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<ChatComposer onSend={onSend} />);
    const composer = screen.getByLabelText("Message");

    await user.type(composer, "  Hello Amy  ");
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(composer, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith({ content: "Hello Amy" });
    expect(composer).toHaveValue("");
  });

  it("supports a safe-link-only message", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<ChatComposer onSend={onSend} />);

    await user.click(screen.getByRole("button", { name: "Add a safe link" }));
    await user.type(screen.getByLabelText("URL"), "https://example.com/resource");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSend).toHaveBeenCalledWith({
      content: null,
      safeLink: { url: "https://example.com/resource" },
    });
  });

  it("rejects unsafe links and more than 4,000 Unicode code points", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<ChatComposer onSend={onSend} />);
    await user.click(screen.getByRole("button", { name: "Add a safe link" }));
    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "javascript:alert(1)" },
    });
    expect(screen.getByText(/must use a valid http/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "😀".repeat(4_001) },
    });
    expect(screen.getByText(/cannot exceed 4,000/)).toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps accessible composer controls unavailable while sending", () => {
    render(<ChatComposer onSend={vi.fn()} sending />);
    expect(screen.getByLabelText("Message")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Message")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("button", { name: "Add a safe link" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });
});
