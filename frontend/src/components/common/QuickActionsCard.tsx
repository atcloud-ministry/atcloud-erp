import { Link } from "react-router-dom";
import {
  ArrowRightIcon,
  ArrowRightOnRectangleIcon,
  CalendarDaysIcon,
  HeartIcon,
  KeyIcon,
  PlusIcon,
  UserCircleIcon,
  UserPlusIcon,
} from "@heroicons/react/24/outline";
import { useAuth } from "../../hooks/useAuth"; // Use real auth context

interface QuickAction {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  requiredRoles?: string[]; // Optional roles that can see this action
}

const quickActions: QuickAction[] = [
  {
    label: "Create New Event",
    href: "/dashboard/new-event",
    icon: PlusIcon,
    requiredRoles: ["Super Admin", "Administrator", "Leader"], // Only these roles can create events
  },
  {
    label: "View Upcoming Events",
    href: "/dashboard/upcoming",
    icon: CalendarDaysIcon,
  },
  {
    label: "Update Profile",
    href: "/dashboard/profile",
    icon: UserCircleIcon,
  },
  {
    label: "Change Password",
    href: "/dashboard/change-password",
    icon: KeyIcon,
  },
];

const guestActions: QuickAction[] = [
  {
    label: "View Upcoming Events",
    href: "/dashboard/upcoming",
    icon: CalendarDaysIcon,
  },
  { label: "Login", href: "/login", icon: ArrowRightOnRectangleIcon },
  { label: "Sign Up", href: "/signup", icon: UserPlusIcon },
  { label: "Donate", href: "/dashboard/donate", icon: HeartIcon },
];

function ActionList({ actions }: { actions: QuickAction[] }) {
  return (
    <ul className="-mx-2 space-y-0.5">
      {actions.map(({ label, href, icon: Icon }) => (
        <li key={label}>
          <Link
            to={href}
            className="group flex items-center gap-3 rounded-xl px-2 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100/80 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 ring-1 ring-inset ring-brand-100 transition-colors group-hover:bg-brand-600 group-hover:text-white group-hover:ring-brand-600">
              <Icon className="h-4 w-4" />
            </span>
            <span className="flex-1">{label}</span>
            <ArrowRightIcon
              aria-hidden="true"
              className="h-4 w-4 -translate-x-1 text-gray-300 opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:text-gray-500 group-hover:opacity-100"
            />
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default function QuickActionsCard() {
  // Get current user role from auth context
  const { currentUser } = useAuth();

  if (!currentUser) {
    return <ActionList actions={guestActions} />;
  }

  const currentUserRole = currentUser.role;

  // Filter actions based on user role
  const visibleActions = quickActions.filter((action) => {
    if (!action.requiredRoles) return true; // Show to everyone if no role requirement
    return action.requiredRoles.includes(currentUserRole);
  });

  return <ActionList actions={visibleActions} />;
}
