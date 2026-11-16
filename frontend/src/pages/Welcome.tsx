import type { ReactNode } from "react";
import { motion } from "motion/react";
import {
  ArrowTopRightOnSquareIcon,
  CalendarDaysIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import {
  DashboardCard,
  QuickActionsCard,
  MinistryStatsCard,
  WelcomeHeader,
  GettingStartedSection,
  Icon,
} from "../components/common";
import { Button } from "../components/ui";
import { Link, useNavigate } from "react-router-dom";
import { useEvents } from "../hooks/useEventsApi";
import { useAuth } from "../hooks/useAuth";
import { formatEventDateTimeRangeInViewerTZ } from "../utils/eventStatsUtils";
import { getLoadingSkeletonClass } from "../utils/uiUtils";

const SECTION_EASE = [0.16, 1, 0.3, 1] as const;

/** Fades each section in shortly after the one above it. */
function Reveal({
  children,
  index,
  className,
}: {
  children: ReactNode;
  index: number;
  className?: string;
}) {
  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className={className}
      initial={{ opacity: 0, y: 12 }}
      transition={{ duration: 0.5, delay: 0.06 * index, ease: SECTION_EASE }}
    >
      {children}
    </motion.div>
  );
}

export default function Welcome() {
  const { currentUser } = useAuth();
  const showMinistryStats = Boolean(
    currentUser && currentUser.role !== "Participant",
  );

  return (
    <div className="space-y-6">
      {/* Welcome Header */}
      <Reveal index={0}>
        <WelcomeHeader />
      </Reveal>

      {/* Dashboard Cards */}
      <div
        className={`grid grid-cols-1 gap-6 ${
          showMinistryStats
            ? "md:grid-cols-2 lg:grid-cols-3" // 3 columns for other roles
            : "md:grid-cols-2" // 2 columns for Participants / guests (no Ministry Stats)
        }`}
      >
        <Reveal index={1}>
          <DashboardCard
            title="Quick Actions"
            icon={<Icon name="lightning" />}
          >
            <QuickActionsCard />
          </DashboardCard>
        </Reveal>

        <Reveal index={2}>
          <DashboardCard
            title="Upcoming Events"
            icon={<Icon name="calendar" />}
          >
            <UpcomingEventsCard />
          </DashboardCard>
        </Reveal>

        {/* Only show Ministry Stats for authenticated non-Participant roles */}
        {showMinistryStats && (
          <Reveal className="md:col-span-2 lg:col-span-1" index={3}>
            <DashboardCard
              title="Ministry Stats"
              icon={<Icon name="bar-chart" />}
            >
              <MinistryStatsCard />
            </DashboardCard>
          </Reveal>
        )}
      </div>

      {/* Our Vision & Mission Card */}
      <Reveal index={4}>
        <DashboardCard
          title="Our Vision & Mission"
          icon={<Icon name="tag" />}
        >
          <div className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-end">
            <div className="max-w-3xl flex-1">
              <p className="mb-3 leading-relaxed text-gray-700">
                The vision of @Cloud is to celebrate and expand God’s kingdom &
                victories in the marketplace. Our mission is to call and equip
                Christian leaders to make an impact in the marketplace. Our
                objectives are to plant Marketplace Churches inside companies,
                and to setup the Marketplace Manger – an incubator facility to
                enable perspective Kingdom-minded entrepreneurs to receive
                advice and mentorship from experienced coaches.
              </p>
              <p className="text-sm text-gray-500">
                Discover opportunities for collaboration, spiritual growth, and
                business development through our comprehensive platform and
                community initiatives.
              </p>
            </div>
            <a
              className="shrink-0"
              href="https://at-cloud.biz/"
              rel="noopener noreferrer"
              target="_blank"
            >
              <Button
                className="flex items-center justify-center rounded-full border border-gray-300 bg-white px-5 py-2 text-sm text-gray-800 shadow-sm transition-colors duration-200 hover:border-gray-400 hover:bg-gray-50"
                rightIcon={
                  <ArrowTopRightOnSquareIcon
                    aria-hidden="true"
                    className="h-4 w-4 flex-shrink-0 text-gray-500"
                  />
                }
                variant="outline"
              >
                <span className="whitespace-nowrap">Return to @Cloud Website</span>
              </Button>
            </a>
          </div>
        </DashboardCard>
      </Reveal>

      {/* Getting Started Section */}
      <Reveal index={5}>
        <GettingStartedSection />
      </Reveal>
    </div>
  );
}

// Simple Upcoming Events Card Component
function UpcomingEventsCard() {
  const navigate = useNavigate();
  const { currentUser } = useAuth();
  const isGuest = !currentUser;
  const { events, loading, error } = useEvents({
    status: "upcoming",
    pageSize: 3, // Only get the first 3 events
  });

  // For guests: only show published events
  const upcomingEvents = isGuest
    ? events.filter((e) => e.publish).slice(0, 3)
    : events.slice(0, 3);

  // eventDate is "YYYY-MM-DD"; parse as a local date to avoid timezone shifts.
  const parseLocalDate = (eventDate: string): Date => {
    const [year, month, day] = eventDate
      .split("-")
      .map((num) => parseInt(num, 10));
    return new Date(year, month - 1, day);
  };

  // Function to calculate days until event
  const getDaysUntilEvent = (eventDate: string): string => {
    const now = new Date();
    const event = parseLocalDate(eventDate);

    // Set both dates to start of day to ignore time components
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );
    const eventStart = new Date(
      event.getFullYear(),
      event.getMonth(),
      event.getDate(),
    );

    const diffTime = eventStart.getTime() - todayStart.getTime();
    const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Tomorrow";
    if (diffDays < 7) return `${diffDays} days`;
    if (diffDays < 14) return "1 week";
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks`;
    return `${Math.floor(diffDays / 30)} month${
      Math.floor(diffDays / 30) > 1 ? "s" : ""
    }`;
  };

  if (loading) {
    // Skeleton loading state (3 placeholder event cards)
    return (
      <div className="space-y-3" data-testid="upcoming-events-skeleton">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="flex animate-pulse items-center gap-3 rounded-xl p-2"
          >
            <div className="h-11 w-11 shrink-0 rounded-lg bg-gray-200"></div>
            <div className="flex-1 space-y-2">
              <div className={`${getLoadingSkeletonClass("text")} w-2/3`}></div>
              <div className={`${getLoadingSkeletonClass("text")} w-5/6`}></div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center py-6 text-center">
        <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-red-50 text-red-500">
          <ExclamationTriangleIcon aria-hidden="true" className="h-5 w-5" />
        </span>
        <span className="text-sm font-medium text-red-700">
          Failed to load events
        </span>
        <p className="mt-1 text-xs text-red-500">{error}</p>
      </div>
    );
  }

  if (upcomingEvents.length === 0) {
    return (
      <div className="flex flex-col items-center py-6 text-center">
        <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-gray-100 text-gray-400">
          <CalendarDaysIcon aria-hidden="true" className="h-5 w-5" />
        </span>
        <span className="text-sm font-medium text-gray-700">
          No upcoming events
        </span>
        <p className="mt-1 text-xs text-gray-500">
          Check back later for new events
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ul className="-mx-2 space-y-1">
        {upcomingEvents.map((event) => {
          const daysUntil = getDaysUntilEvent(event.date);
          const date = parseLocalDate(event.date);

          return (
            <li key={event.id}>
              <Link
                to={
                  isGuest
                    ? event.publicSlug
                      ? `/p/${event.publicSlug}`
                      : "/events"
                    : `/dashboard/event/${event.id}`
                }
                className="group flex items-center gap-3 rounded-xl p-2 transition-colors hover:bg-gray-100/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <span
                  aria-hidden="true"
                  className="flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-lg border border-gray-200 bg-white leading-none shadow-sm transition-colors group-hover:border-brand-200"
                >
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-brand-600">
                    {date.toLocaleString("en-US", { month: "short" })}
                  </span>
                  <span className="mt-0.5 text-base font-semibold text-gray-900">
                    {date.getDate()}
                  </span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-gray-900">
                    {event.title}
                  </span>
                  <span className="block truncate whitespace-nowrap text-xs text-gray-500">
                    {formatEventDateTimeRangeInViewerTZ(
                      event.date,
                      event.time,
                      event.endTime,
                      event.timeZone,
                      event.endDate,
                    )}
                  </span>
                </span>
                <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">
                  {daysUntil}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="border-t border-gray-100 pt-2">
        <Button
          variant="link"
          onClick={() => navigate("/dashboard/upcoming")}
          className="w-full text-sm"
        >
          View All Upcoming Events
        </Button>
      </div>
    </div>
  );
}
