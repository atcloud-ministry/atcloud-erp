import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AcademicCapIcon,
  ArrowDownTrayIcon,
  CalendarDaysIcon,
  ChartBarIcon,
  ClipboardDocumentCheckIcon,
  CurrencyDollarIcon,
  UsersIcon,
} from "@heroicons/react/24/solid";
import { useAuth } from "../hooks/useAuth";
import {
  useAnalyticsOverviewResource,
  useAttendanceAnalyticsResource,
  useDonationAnalyticsResource,
  useEventAnalyticsResource,
  useFinancialSummaryResource,
  useProgramAnalyticsResource,
  useUserAnalyticsResource,
} from "../hooks/useAnalyticsResources";
import {
  AnalyticsOverviewLoadingState,
  AnalyticsCardSectionLoadingState,
} from "../components/ui/LoadingStates";
import { TabNav } from "../components/ui";
import type { EventData } from "../types/event";
import {
  calculateEventAnalytics,
  calculateGuestAggregates,
  calculateUserEngagement,
} from "../utils/analyticsCalculations";
import { AnalyticsOverviewCards } from "../components/analytics/AnalyticsOverviewCards";
import { FinancialHealthCards } from "../components/analytics/FinancialHealthCards";
import { FinancialTrendsChart } from "../components/analytics/FinancialTrendsChart";
import { EventStatisticsCards } from "../components/analytics/EventStatisticsCards";
import {
  EventFormatDistributionCard,
  SystemAuthorizationDistributionCard,
} from "../components/analytics/RoleFormatDistribution";
import { UserEngagementSection } from "../components/analytics/UserEngagementSection";
import { ParticipantDemographics } from "../components/analytics/ParticipantDemographics";
import { RegistrationProfileKpis } from "../components/analytics/RegistrationProfileKpis";
import { ProgramAnalyticsSection } from "../components/analytics/ProgramAnalyticsSection";
import { DonationAnalyticsSection } from "../components/analytics/DonationAnalyticsSection";
import { AttendanceAnalyticsSection } from "../components/analytics/AttendanceAnalyticsSection";
import { analyticsService } from "../services/api/analytics.api";
import { useToastReplacement } from "../contexts/NotificationModalContext";

type AnalyticsTab =
  | "overview"
  | "events"
  | "attendance"
  | "people"
  | "programs"
  | "finance";

type AnalyticsTabConfig = {
  id: AnalyticsTab;
  label: string;
  icon: typeof ChartBarIcon;
  requiresFinancialAccess?: boolean;
};

type EventAnalyticsPayload = {
  upcomingEvents?: unknown[];
  completedEvents?: unknown[];
};

const tabs: AnalyticsTabConfig[] = [
  { id: "overview", label: "Overview", icon: ChartBarIcon },
  { id: "events", label: "Events", icon: CalendarDaysIcon },
  {
    id: "attendance",
    label: "Attendance",
    icon: ClipboardDocumentCheckIcon,
  },
  { id: "people", label: "People", icon: UsersIcon },
  { id: "programs", label: "Programs", icon: AcademicCapIcon },
  {
    id: "finance",
    label: "Giving & Finance",
    icon: CurrencyDollarIcon,
    requiresFinancialAccess: true,
  },
];

function isEventData(item: unknown): item is EventData {
  if (!item || typeof item !== "object") return false;
  const event = item as Partial<EventData>;
  return (
    typeof event.id === "string" &&
    typeof event.title === "string" &&
    Array.isArray(event.roles)
  );
}

function SectionError({ message }: { message: string }) {
  return (
    <div className="bg-red-50 border border-red-200 rounded-lg p-4">
      <p className="text-sm text-red-700">{message}</p>
    </div>
  );
}

function getEventPayload(data: unknown): EventAnalyticsPayload {
  return data && typeof data === "object"
    ? (data as EventAnalyticsPayload)
    : {};
}

export default function Analytics() {
  const { currentUser } = useAuth();
  const notification = useToastReplacement();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showExportMenu, setShowExportMenu] = useState(false);

  const hasAnalyticsAccess =
    !!currentUser &&
    ["Super Admin", "Administrator", "Leader"].includes(currentUser.role);
  const hasFinancialAccess =
    !!currentUser &&
    ["Super Admin", "Administrator"].includes(currentUser.role);

  const availableTabs = useMemo(
    () =>
      tabs.filter((tab) => !tab.requiresFinancialAccess || hasFinancialAccess),
    [hasFinancialAccess],
  );

  const requestedTab = searchParams.get("tab") as AnalyticsTab | null;
  const activeTab = availableTabs.some((tab) => tab.id === requestedTab)
    ? (requestedTab as AnalyticsTab)
    : "overview";

  useEffect(() => {
    if (!hasAnalyticsAccess) return;
    if (requestedTab === activeTab) return;

    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("tab", activeTab);
    setSearchParams(nextParams, { replace: true });
  }, [
    activeTab,
    hasAnalyticsAccess,
    requestedTab,
    searchParams,
    setSearchParams,
  ]);

  useEffect(() => {
    const handleClickOutside = () => {
      if (showExportMenu) setShowExportMenu(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowExportMenu(false);
    };

    if (showExportMenu) {
      document.addEventListener("click", handleClickOutside);
      document.addEventListener("keydown", handleEscape);
      return () => {
        document.removeEventListener("click", handleClickOutside);
        document.removeEventListener("keydown", handleEscape);
      };
    }
  }, [showExportMenu]);

  const overviewResource = useAnalyticsOverviewResource(
    hasAnalyticsAccess && activeTab === "overview",
  );
  const eventResource = useEventAnalyticsResource(
    hasAnalyticsAccess && (activeTab === "events" || activeTab === "people"),
  );
  const userResource = useUserAnalyticsResource(
    hasAnalyticsAccess && activeTab === "people",
  );
  const attendanceResource = useAttendanceAnalyticsResource(
    hasAnalyticsAccess && activeTab === "attendance",
  );
  const programResource = useProgramAnalyticsResource(
    hasAnalyticsAccess && activeTab === "programs",
  );
  const financialSummaryResource = useFinancialSummaryResource(
    hasFinancialAccess && activeTab === "finance",
  );
  const donationResource = useDonationAnalyticsResource(
    hasFinancialAccess && activeTab === "finance",
  );

  const eventPayload = useMemo(
    () => getEventPayload(eventResource.data),
    [eventResource.data],
  );

  const upcomingEvents = useMemo<EventData[]>(() => {
    const src = eventPayload.upcomingEvents;
    return Array.isArray(src) ? src.filter(isEventData) : [];
  }, [eventPayload]);

  const passedEvents = useMemo<EventData[]>(() => {
    const src = eventPayload.completedEvents;
    return Array.isArray(src) ? src.filter(isEventData) : [];
  }, [eventPayload]);

  const eventAnalytics = useMemo(
    () => calculateEventAnalytics(upcomingEvents, passedEvents),
    [upcomingEvents, passedEvents],
  );
  const engagementMetrics = useMemo(
    () => calculateUserEngagement(upcomingEvents, passedEvents),
    [upcomingEvents, passedEvents],
  );
  const guestAggregates = useMemo(
    () => calculateGuestAggregates(upcomingEvents, passedEvents),
    [upcomingEvents, passedEvents],
  );
  const avgRolesPerParticipant = useMemo(
    () =>
      engagementMetrics.uniqueParticipants > 0
        ? engagementMetrics.userSignups / engagementMetrics.uniqueParticipants
        : 0,
    [engagementMetrics.userSignups, engagementMetrics.uniqueParticipants],
  );
  const handleTabChange = (tabId: AnalyticsTab) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("tab", tabId);
    setSearchParams(nextParams);
  };

  const handleExport = useCallback(
    async (format: "xlsx" | "csv" | "json" = "xlsx") => {
      try {
        const blob = await analyticsService.exportAnalytics(format);
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `analytics-export.${format}`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        setShowExportMenu(false);
        notification.success("Analytics exported successfully");
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Failed to export analytics";
        notification.error(message);
      }
    },
    [notification],
  );

  const handleProfileKpiExport = useCallback(async () => {
    try {
      const blob = await analyticsService.exportRegistrationProfileKpis(
        "xlsx",
      );
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "registration-profile-kpis.xlsx";
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      setShowExportMenu(false);
      notification.success("Profile KPIs exported successfully");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to export profile KPIs";
      notification.error(message);
    }
  }, [notification]);

  if (!hasAnalyticsAccess) {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="bg-white rounded-lg shadow-sm p-6">
          <div className="text-center py-12">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-100 flex items-center justify-center">
              <ChartBarIcon className="w-8 h-8 text-red-600" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">
              Access Restricted
            </h2>
            <p className="text-gray-600 mb-4">
              You don't have permission to access the Analytics dashboard.
            </p>
            <p className="text-sm text-gray-500">
              Analytics access is restricted to Super Admins, Administrators,
              and Leaders only.
            </p>
            <p className="text-sm text-gray-500 mt-2">
              To request access as an @Cloud co-worker, please contact your
              @Cloud Leaders.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const overview = overviewResource.data?.overview;
  const overviewIsLoading =
    overviewResource.loading ||
    (activeTab === "overview" && !overviewResource.data && !overviewResource.error);
  const eventsAreLoading =
    eventResource.loading ||
    ((activeTab === "events" || activeTab === "people") &&
      !eventResource.data &&
      !eventResource.error);
  const usersAreLoading =
    userResource.loading ||
    (activeTab === "people" && !userResource.data && !userResource.error);
  const attendanceIsLoading =
    attendanceResource.loading ||
    (activeTab === "attendance" &&
      !attendanceResource.data &&
      !attendanceResource.error);
  const programsAreLoading =
    programResource.loading ||
    (activeTab === "programs" && !programResource.data && !programResource.error);
  const financeIsLoading =
    financialSummaryResource.loading ||
    donationResource.loading ||
    (activeTab === "finance" &&
      (!financialSummaryResource.data || !donationResource.data) &&
      !financialSummaryResource.error &&
      !donationResource.error);

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        <div className="flex flex-col gap-4 p-6 pb-4 lg:flex-row lg:items-center lg:justify-between">
          <h1 className="text-2xl font-bold text-gray-900">
            Analytics Dashboard
          </h1>
          <div className="relative self-start lg:self-auto">
            <button
              aria-controls="analytics-export-menu"
              aria-expanded={showExportMenu}
              onClick={(e) => {
                e.stopPropagation();
                setShowExportMenu(!showExportMenu);
              }}
              className="inline-flex items-center px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-md hover:bg-green-700 transition-colors"
            >
              <ArrowDownTrayIcon className="w-4 h-4 mr-2" />
              Export Data
            </button>

            {showExportMenu && (
              <div
                className="absolute right-0 mt-2 w-56 bg-white border border-gray-200 rounded-md shadow-lg z-10"
                id="analytics-export-menu"
                role="group"
                aria-label="Export options"
              >
                <div className="py-1">
                  {activeTab === "people" &&
                    userResource.data?.registrationProfileKpis && (
                      <>
                        <button
                          className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                          onClick={() => void handleProfileKpiExport()}
                        >
                          <div className="font-medium">
                            Export Profile KPIs (Excel)
                          </div>
                          <div className="text-xs text-gray-500">
                            Only aggregate groups meeting the privacy threshold
                          </div>
                        </button>
                        <div
                          className="my-1 border-t border-gray-100"
                          role="separator"
                        />
                      </>
                    )}
                  <button
                    onClick={() => void handleExport("xlsx")}
                    className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                  >
                    <div className="font-medium">Export All (Excel)</div>
                    <div className="text-xs text-gray-500">
                      Users, Events, Programs, Donations
                    </div>
                  </button>
                  <button
                    onClick={() => void handleExport("csv")}
                    className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                  >
                    <div className="font-medium">Export Summary (CSV)</div>
                    <div className="text-xs text-gray-500">Counts only</div>
                  </button>
                  <button
                    onClick={() => void handleExport("json")}
                    className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                  >
                    <div className="font-medium">Export All (JSON)</div>
                    <div className="text-xs text-gray-500">
                      Authorized operational data
                    </div>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <TabNav
          tabs={availableTabs}
          activeTab={activeTab}
          onTabChange={handleTabChange}
          ariaLabel="Analytics sections"
        />

        <div className="p-6">
          {activeTab === "overview" && (
            <>
              {overviewResource.error ? (
                <SectionError message={overviewResource.error} />
              ) : overviewIsLoading || !overview ? (
                <AnalyticsOverviewLoadingState />
              ) : (
                <AnalyticsOverviewCards analytics={overviewResource.data!} />
              )}
            </>
          )}

          {activeTab === "events" && (
            <>
              {eventResource.error ? (
                <SectionError message={eventResource.error} />
              ) : eventsAreLoading ? (
                <AnalyticsCardSectionLoadingState cardCount={2} itemCount={5} />
              ) : (
                <div className="space-y-6">
                  <EventStatisticsCards
                    upcomingEvents={eventAnalytics.upcomingEvents}
                    upcomingStats={eventAnalytics.upcomingStats}
                    passedEvents={eventAnalytics.passedEvents}
                    passedStats={eventAnalytics.passedStats}
                  />
                  <EventFormatDistributionCard
                    formatStats={eventAnalytics.formatStats}
                  />
                </div>
              )}
            </>
          )}

          {activeTab === "attendance" && (
            <>
              {attendanceResource.error ? (
                <SectionError message={attendanceResource.error} />
              ) : attendanceIsLoading || !attendanceResource.data ? (
                <AnalyticsCardSectionLoadingState cardCount={3} itemCount={6} />
              ) : (
                <AttendanceAnalyticsSection
                  analytics={attendanceResource.data}
                />
              )}
            </>
          )}

          {activeTab === "people" && (
            <>
              {eventResource.error || userResource.error ? (
                <SectionError
                  message={
                    eventResource.error ||
                    userResource.error ||
                    "Failed to load people analytics"
                  }
                />
              ) : eventsAreLoading || usersAreLoading || !userResource.data ? (
                <AnalyticsCardSectionLoadingState cardCount={2} itemCount={6} />
              ) : (
                <div className="space-y-6">
                  <UserEngagementSection
                    mostActiveUsers={engagementMetrics.mostActiveUsers}
                    uniqueParticipants={engagementMetrics.uniqueParticipants}
                    userSignups={engagementMetrics.userSignups}
                    guestSignups={guestAggregates.guestSignups}
                    uniqueGuests={guestAggregates.uniqueGuests}
                    totalEvents={eventAnalytics.totalEvents}
                    avgRolesPerParticipant={avgRolesPerParticipant}
                  />
                  <SystemAuthorizationDistributionCard
                    roleStats={userResource.data.demographics.roleStats}
                  />
                  <ParticipantDemographics
                    churchAnalytics={
                      userResource.data.demographics.churchAnalytics
                    }
                    occupationAnalytics={
                      userResource.data.demographics.occupationAnalytics
                    }
                    showOccupation={!userResource.data.registrationProfileKpis}
                  />
                  {userResource.data.registrationProfileKpis && (
                    <RegistrationProfileKpis
                      analytics={userResource.data.registrationProfileKpis}
                    />
                  )}
                </div>
              )}
            </>
          )}

          {activeTab === "programs" && (
            <>
              {programResource.error ? (
                <SectionError message={programResource.error} />
              ) : programsAreLoading || !programResource.data ? (
                <AnalyticsCardSectionLoadingState cardCount={2} itemCount={5} />
              ) : (
                <ProgramAnalyticsSection analytics={programResource.data} />
              )}
            </>
          )}

          {activeTab === "finance" && hasFinancialAccess && (
            <>
              {financialSummaryResource.error || donationResource.error ? (
                <SectionError
                  message={
                    financialSummaryResource.error ||
                    donationResource.error ||
                    "Failed to load financial analytics"
                  }
                />
              ) : financeIsLoading ||
                !financialSummaryResource.data ||
                !donationResource.data ? (
                <AnalyticsCardSectionLoadingState cardCount={2} itemCount={5} />
              ) : (
                <div className="space-y-6">
                  <FinancialHealthCards
                    totalRevenue={financialSummaryResource.data.totalRevenue}
                    programRevenue={
                      financialSummaryResource.data.programs.revenue
                    }
                    programPurchases={
                      financialSummaryResource.data.programs.purchases
                    }
                    donationRevenue={
                      financialSummaryResource.data.donations.revenue
                    }
                    donationGifts={
                      financialSummaryResource.data.donations.gifts
                    }
                    last30DaysRevenue={
                      financialSummaryResource.data.last30Days.revenue
                    }
                    last30DaysPercentage={
                      financialSummaryResource.data.last30Days.percentage
                    }
                    growthRate={financialSummaryResource.data.growthRate}
                  />
                  <FinancialTrendsChart />
                  <DonationAnalyticsSection analytics={donationResource.data} />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
