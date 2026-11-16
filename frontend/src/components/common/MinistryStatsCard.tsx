import { useState, useEffect } from "react";
import { StatsLoadingState } from "../ui/LoadingStates";
import { analyticsService } from "../../services/api";

// Minimal analytics response shapes to avoid any/unknown here
interface EventAnalyticsRole {
  maxParticipants?: number;
  currentSignups?: unknown[];
  registrations?: unknown[];
  currentCount?: number;
}
interface EventAnalyticsItem {
  roles?: EventAnalyticsRole[];
}
interface EventAnalyticsResponse {
  upcomingEvents?: EventAnalyticsItem[];
  completedEvents?: EventAnalyticsItem[];
}

interface StatItem {
  label: string;
  value: string | number;
  colorClass: string;
}

export default function MinistryStatsCard() {
  const [ministryStats, setMinistryStats] = useState<StatItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Function to calculate real ministry statistics from backend data
  const calculateMinistryStats = async (): Promise<StatItem[]> => {
    try {
      // Fetch events with registration data from analytics API
      const response =
        (await analyticsService.getEventAnalytics()) as EventAnalyticsResponse;
      const upcomingEvents = response.upcomingEvents || [];
      const completedEvents = response.completedEvents || [];

      const totalEvents = upcomingEvents.length + completedEvents.length;

      // Calculate total signups and slots from roles array
      let totalSignups = 0;
      let totalSlots = 0;

      upcomingEvents.forEach((event) => {
        if (event.roles && Array.isArray(event.roles)) {
          event.roles.forEach((role) => {
            // Add max participants to total slots
            totalSlots += role.maxParticipants || 0;

            // Count current signups for this role
            if (Array.isArray(role?.currentSignups)) {
              totalSignups += role.currentSignups.length;
            } else if (Array.isArray(role?.registrations)) {
              totalSignups += role.registrations.length;
            } else if (typeof role?.currentCount === "number") {
              totalSignups += role.currentCount;
            }
          });
        }
      });

      return [
        {
          label: "Total Events",
          value: totalEvents,
          colorClass: "text-gray-900",
        },
        {
          label: "Upcoming Events",
          value: upcomingEvents.length,
          colorClass: "text-gray-900",
        },
        {
          label: "Total Signups",
          value: totalSignups,
          colorClass: "text-gray-900",
        },
        {
          label: "Available Spots",
          value: Math.max(0, totalSlots - totalSignups),
          colorClass: "text-gray-900",
        },
      ];
    } catch (error) {
      console.error("Error calculating ministry stats:", error);
      // Return default stats on error
      return [
        { label: "Total Events", value: 0, colorClass: "text-gray-900" },
        { label: "Upcoming Events", value: 0, colorClass: "text-gray-900" },
        { label: "Total Signups", value: 0, colorClass: "text-gray-900" },
        { label: "Available Spots", value: 0, colorClass: "text-gray-900" },
      ];
    }
  };

  useEffect(() => {
    const loadStats = async () => {
      setLoading(true);
      try {
        const stats = await calculateMinistryStats();
        setMinistryStats(stats);
      } catch (error) {
        console.error("Error loading ministry stats:", error);
      } finally {
        setLoading(false);
      }
    };

    loadStats();
  }, []);

  if (loading) {
    return <StatsLoadingState count={4} />;
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      {ministryStats.map((stat) => (
        <div key={stat.label} className="flex flex-col-reverse rounded-xl bg-gray-50 px-3.5 py-3 ring-1 ring-inset ring-gray-200/70">
          <span className="mt-1 text-xs font-medium text-gray-500">{stat.label}</span>
          <span className={`font-display text-2xl font-semibold tabular-nums ${stat.colorClass}`}>
            {stat.value}
          </span>
        </div>
      ))}
    </div>
  );
}
