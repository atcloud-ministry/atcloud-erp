import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import PricingConfirmationModal from "../../components/EditProgram/PricingConfirmationModal";
import ConfirmationModal from "../../components/common/ConfirmationModal";
import ConfirmLogoutModal from "../../components/common/ConfirmLogoutModal";
import NotificationModal from "../../components/common/NotificationModal";
import UserDeleteModal from "../../components/management/UserDeleteModal";
import {
  NotificationProvider,
  useNotification,
} from "../../contexts/NotificationModalContext";

afterEach(() => {
  vi.useRealTimers();
});

function NotificationHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Open notification
      </button>
      <NotificationModal
        actionButton={{ text: "Review", onClick: vi.fn() }}
        isOpen={open}
        message="Review the updated details."
        onClose={() => setOpen(false)}
        title="Update available"
      />
    </>
  );
}

function PricingHarness() {
  const [show, setShow] = useState(false);
  return (
    <>
      <button onClick={() => setShow(true)} type="button">
        Change tuition
      </button>
      <PricingConfirmationModal
        currentClassRepDiscount={0}
        currentEarlyBirdDiscount={0}
        currentFullPrice={150}
        currentIsFree={false}
        isSubmitting={false}
        onCancel={() => setShow(false)}
        onNext={vi.fn()}
        originalPricing={{ fullPriceTicket: 10_000, isFree: false }}
        show={show}
        step={1}
      />
    </>
  );
}

function TimedNotificationHarness() {
  const { showNotification } = useNotification();
  return (
    <button
      onClick={() =>
        showNotification({
          autoClose: true,
          autoCloseDelay: 10,
          message: "This message waits for the user.",
          title: "Persistent notice",
        })
      }
      type="button"
    >
      Show timed notification
    </button>
  );
}

function ConfirmationHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Open confirmation
      </button>
      <ConfirmationModal
        confirmText="Remove"
        isOpen={open}
        message="This removes the selected access."
        onClose={() => setOpen(false)}
        onConfirm={vi.fn()}
        title="Remove access"
      />
    </>
  );
}

function UserDeleteHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Open user deletion
      </button>
      <UserDeleteModal
        isOpen={open}
        message="The account will be deleted."
        onClose={() => setOpen(false)}
        onConfirm={vi.fn()}
        title="Delete account"
        userName="Amy Chen"
      />
    </>
  );
}

function LogoutHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Open logout
      </button>
      <ConfirmLogoutModal
        onCancel={() => setOpen(false)}
        onConfirm={vi.fn()}
        open={open}
      />
    </>
  );
}

describe("G1 accessible dialogs", () => {
  it("names the notification dialog, traps Tab, closes with Escape, and restores focus", async () => {
    const user = userEvent.setup();
    render(<NotificationHarness />);
    const opener = screen.getByRole("button", { name: "Open notification" });

    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Update available" });
    expect(dialog).toHaveAccessibleDescription("Review the updated details.");

    const cancel = screen.getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toHaveFocus());

    await user.tab();
    expect(
      screen.getByRole("button", { name: "Close notification" }),
    ).toHaveFocus();
    await user.tab({ shift: true });
    expect(cancel).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("isolates notification controls from the global button defaults", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const onClose = vi.fn();
    render(
      <NotificationModal
        actionButton={{ text: "Open Chat Room", onClick: onAction }}
        closeButtonText="Later"
        isOpen
        message="Your private Alumni Help Chat Room is ready."
        onClose={onClose}
        title="Chat Room created"
        type="success"
      />,
    );

    const closeControl = screen.getByRole("button", {
      name: "Close notification",
    });
    const action = screen.getByRole("button", { name: "Open Chat Room" });
    const later = screen.getByRole("button", { name: "Later" });

    expect(closeControl).toHaveClass(
      "!rounded-lg",
      "!border-0",
      "!bg-transparent",
      "!p-0",
    );
    expect(closeControl.querySelector("svg")).toHaveClass("w-5", "h-5");
    expect(action).toHaveClass(
      "!rounded-lg",
      "!border-0",
      "!px-4",
      "!py-2",
      "!bg-green-700",
      "hover:!bg-green-800",
    );
    expect(later).toHaveClass(
      "!rounded-lg",
      "!border-0",
      "!bg-gray-100",
      "!px-4",
      "!py-2",
    );

    await user.click(action);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("applies the same focus and Escape contract to tuition confirmation", async () => {
    const user = userEvent.setup();
    render(<PricingHarness />);
    const opener = screen.getByRole("button", { name: "Change tuition" });

    await user.click(opener);
    const dialog = screen.getByRole("dialog", {
      name: "Tuition Changes Detected",
    });
    expect(dialog).toHaveAccessibleDescription(
      /changes to the program's tuition section/i,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus(),
    );

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("does not dismiss a modal before the user has time to read it", () => {
    vi.useFakeTimers();
    render(
      <NotificationProvider>
        <TimedNotificationHarness />
      </NotificationProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Show timed notification" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Persistent notice" }),
    ).toBeVisible();

    act(() => vi.advanceTimersByTime(30_000));
    expect(
      screen.getByRole("dialog", { name: "Persistent notice" }),
    ).toBeVisible();
  });

  it("gives the shared confirmation modal a trapped keyboard dialog", async () => {
    const user = userEvent.setup();
    render(<ConfirmationHarness />);
    const opener = screen.getByRole("button", { name: "Open confirmation" });

    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Remove access" });
    expect(dialog).toHaveAccessibleDescription(
      "This removes the selected access.",
    );
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Remove" });
    await waitFor(() => expect(cancel).toHaveFocus());
    await user.tab();
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("labels user deletion, focuses its confirmation field, and restores focus", async () => {
    const user = userEvent.setup();
    render(<UserDeleteHarness />);
    const opener = screen.getByRole("button", { name: "Open user deletion" });

    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Delete account" });
    expect(dialog).toHaveAccessibleDescription(
      /The account will be deleted.*Type the user's full name to confirm:/,
    );
    const nameField = screen.getByRole("textbox", {
      name: "Type the user's full name to confirm:",
    });
    await waitFor(() => expect(nameField).toHaveFocus());

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("applies the dialog contract to logout confirmation", async () => {
    const user = userEvent.setup();
    render(<LogoutHarness />);
    const opener = screen.getByRole("button", { name: "Open logout" });

    await user.click(opener);
    expect(
      screen.getByRole("dialog", { name: "Confirm Logout" }),
    ).toHaveAccessibleDescription(
      "Are you sure you want to log out? You can sign back in anytime.",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus(),
    );

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
  });
});
