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

  it("keeps composer controls aligned to the input row with comfortable icons", () => {
    render(<ChatComposer onSend={vi.fn()} />);

    const composer = screen.getByLabelText("Message");
    const linkButton = screen.getByRole("button", {
      name: "Add a safe link",
    });
    const sendButton = screen.getByRole("button", { name: "Send message" });
    const counter = screen.getByText("0 / 4,000");

    expect(linkButton).toHaveClass("min-h-11", "min-w-11", "!p-0");
    expect(sendButton).toHaveClass(
      "min-h-11",
      "min-w-11",
      "!bg-blue-600",
      "!p-0",
    );
    expect(linkButton.querySelector("svg")).toHaveClass("h-6", "w-6");
    expect(sendButton.querySelector("svg")).toHaveClass("h-6", "w-6");
    expect(counter.parentElement).toHaveClass("col-start-2");
    expect(composer).toHaveClass("resize-none");
    expect(composer).not.toHaveClass("resize-y");
    expect(composer).not.toHaveClass("focus:border-blue-500");
    expect(composer).not.toHaveClass("focus:ring-2");
    expect(composer).not.toHaveClass("focus:ring-blue-500");
    // Mouse focus stays visually quiet; keyboard focus retains a thin neutral
    // indicator for reliable keyboard navigation.
    expect(composer).toHaveClass(
      "focus-visible:ring-1",
      "focus-visible:ring-gray-400",
    );
  });

  it("grows with message content and scrolls after the composer height limit", () => {
    render(<ChatComposer onSend={vi.fn()} />);
    const composer = screen.getByLabelText("Message");

    Object.defineProperty(composer, "scrollHeight", {
      configurable: true,
      get: () => 88,
    });
    fireEvent.change(composer, { target: { value: "A message on several lines" } });

    expect(composer).toHaveStyle({ height: "88px", overflowY: "hidden" });

    Object.defineProperty(composer, "scrollHeight", {
      configurable: true,
      get: () => 240,
    });
    fireEvent.change(composer, { target: { value: "A much longer message" } });

    expect(composer).toHaveStyle({ height: "144px", overflowY: "auto" });
  });
});
