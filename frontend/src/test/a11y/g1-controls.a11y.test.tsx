import { useCallback, useEffect, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import AnnouncementComposer from "../../components/chat/AnnouncementComposer";
import ChatComposer from "../../components/chat/ChatComposer";
import ActionDropdown from "../../components/management/ActionDropdown";
import Pagination from "../../components/common/Pagination";
import UserSearchAndFilter from "../../components/management/UserSearchAndFilter";
import AvatarUpload from "../../components/profile/AvatarUpload";
import ProfileFormFields from "../../components/profile/ProfileFormFields";
import type { ProfileFormData } from "../../schemas/profileSchema";

function InvalidProfileHarness() {
  const form = useForm<ProfileFormData>({
    defaultValues: {
      email: "person@example.com",
      firstName: "Amy",
      gender: "female",
      isAtCloudLeader: "No",
      lastName: "Chen",
      username: "amy",
    } as ProfileFormData,
  });

  useEffect(() => {
    form.setError("username", { message: "Username is unavailable." });
  }, [form]);

  return <ProfileFormFields form={form} isEditing />;
}

function ActionDropdownHarness({ onAction }: { onAction: () => void }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  return (
    <ActionDropdown
      actions={[
        {
          className: "text-blue-700",
          label: "Promote member",
          onClick: onAction,
        },
        {
          className: "text-red-700",
          label: "Deactivate member",
          onClick: vi.fn(),
        },
      ]}
      isOpen={open}
      onToggle={toggle}
      userId="member-1"
      userName="Amy Chen"
    />
  );
}

describe("G1 accessible controls", () => {
  it("gives the avatar picker a keyboard-accessible name and guidance", () => {
    render(
      <AvatarUpload
        avatarPreview=""
        gender="female"
        isEditing
        onAvatarChange={vi.fn()}
      />,
    );

    const picker = screen.getByLabelText("Change profile picture");
    expect(picker).toHaveAttribute("type", "file");
    expect(picker).toHaveAccessibleDescription(
      "Choose the camera button to change your profile picture",
    );
  });

  it("associates profile labels, required state, and validation errors", async () => {
    const { container } = render(<InvalidProfileHarness />);

    const username = screen.getByRole("textbox", {
      name: "Username (required)",
    });
    await waitFor(() => expect(username).toHaveAttribute("aria-invalid", "true"));
    expect(username).toHaveAccessibleDescription("Username is unavailable.");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Username is unavailable.",
    );

    const results = await axe.run(container);
    expect(
      results.violations.filter(
        (violation) =>
          violation.impact === "serious" || violation.impact === "critical",
      ),
    ).toEqual([]);
  });

  it("exposes search, disclosure state, filter labels, and result updates", async () => {
    const user = userEvent.setup();
    render(
      <UserSearchAndFilter
        currentUserRole="Administrator"
        loading={false}
        onFiltersChange={vi.fn()}
        totalResults={2}
      />,
    );

    expect(screen.getByRole("textbox", { name: "Search users" })).toBeVisible();
    const disclosure = screen.getByRole("button", { name: "Sort & Filter" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await user.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("combobox", { name: "Sort By" })).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "System Authorization Level" }),
    ).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("2 users found");
  });

  it("keeps a focused Management search control available while results refresh", () => {
    const onFiltersChange = vi.fn();
    const { rerender } = render(
      <UserSearchAndFilter
        currentUserRole="Administrator"
        loading={false}
        onFiltersChange={onFiltersChange}
        totalResults={2}
      />,
    );
    const search = screen.getByRole("textbox", { name: "Search users" });
    search.focus();

    rerender(
      <UserSearchAndFilter
        currentUserRole="Administrator"
        loading
        onFiltersChange={onFiltersChange}
        totalResults={2}
      />,
    );

    expect(search).toHaveFocus();
    expect(search).not.toBeDisabled();
    expect(search).toHaveAttribute("aria-disabled", "true");
    expect(search).toHaveAttribute("readonly");
  });

  it("keeps pagination focus during loading and moves it to status at a boundary", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    const { rerender } = render(
      <Pagination
        currentPage={1}
        hasNext
        hasPrev={false}
        onPageChange={onPageChange}
        totalPages={2}
      />,
    );
    const next = screen.getByRole("button", { name: "Next page" });
    await user.click(next);
    expect(onPageChange).toHaveBeenCalledWith(2);

    rerender(
      <Pagination
        busy
        currentPage={1}
        hasNext
        hasPrev={false}
        onPageChange={onPageChange}
        totalPages={2}
      />,
    );
    expect(next).toHaveFocus();
    expect(next).toHaveAttribute("aria-disabled", "true");

    rerender(
      <Pagination
        currentPage={2}
        hasNext={false}
        hasPrev
        onPageChange={onPageChange}
        totalPages={2}
      />,
    );
    await waitFor(() => expect(screen.getByText("Page 2 of 2")).toHaveFocus());
  });

  it("moves focus into and back out of the announcement disclosure", async () => {
    const user = userEvent.setup();
    render(<AnnouncementComposer onPublish={vi.fn()} />);
    const opener = screen.getByRole("button", { name: "Post announcement" });

    await user.click(opener);
    const editor = screen.getByRole("textbox", {
      name: "Program announcement",
    });
    expect(editor).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancel announcement" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Post announcement" }),
      ).toHaveFocus(),
    );
  });

  it("associates unsafe-link feedback with the invalid Chat Room field", async () => {
    const user = userEvent.setup();
    render(<ChatComposer onSend={vi.fn()} />);
    const opener = screen.getByRole("button", { name: "Add a safe link" });
    await user.click(opener);
    const url = screen.getByRole("textbox", { name: "URL" });
    expect(url).toHaveFocus();
    await user.type(url, "javascript:alert(1)");

    expect(url).toHaveAttribute("aria-invalid", "true");
    expect(url).toHaveAccessibleDescription(
      "Links must use a valid http:// or https:// address.",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Links must use a valid http:// or https:// address.",
    );

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "URL" })).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("keeps the message editor focused while a submitted message is sending", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const { rerender } = render(<ChatComposer onSend={onSend} />);
    const message = screen.getByRole("textbox", { name: "Message" });
    await user.type(message, "Thank you");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledOnce();

    rerender(<ChatComposer onSend={onSend} sending />);
    expect(message).toHaveFocus();
    expect(message).not.toBeDisabled();
    expect(message).toHaveAttribute("readonly");
    expect(message).toHaveAttribute("aria-disabled", "true");
  });

  it("restores announcement focus to a focusable busy trigger", async () => {
    const user = userEvent.setup();
    const onPublish = vi.fn();
    const { rerender } = render(<AnnouncementComposer onPublish={onPublish} />);
    await user.click(screen.getByRole("button", { name: "Post announcement" }));
    await user.type(
      screen.getByRole("textbox", { name: "Program announcement" }),
      "Program starts tomorrow",
    );
    await user.click(
      screen.getByRole("button", { name: "Publish announcement" }),
    );
    const trigger = await screen.findByRole("button", {
      name: "Post announcement",
    });

    rerender(<AnnouncementComposer onPublish={onPublish} sending />);
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).not.toBeDisabled();
    expect(trigger).toHaveAttribute("aria-disabled", "true");
  });

  it("supports a named, arrow-keyed Management action menu and restores focus", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<ActionDropdownHarness onAction={onAction} />);
    const trigger = screen.getByRole("button", { name: "Actions for Amy Chen" });

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    const promote = await screen.findByRole("menuitem", {
      name: "Promote member",
    });
    await waitFor(() => expect(promote).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(
      screen.getByRole("menuitem", { name: "Deactivate member" }),
    ).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());

    await user.keyboard("{ArrowDown}");
    const reopenedPromote = await screen.findByRole("menuitem", {
      name: "Promote member",
    });
    await waitFor(() => expect(reopenedPromote).toHaveFocus());
    await user.keyboard("{Enter}");
    expect(onAction).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
