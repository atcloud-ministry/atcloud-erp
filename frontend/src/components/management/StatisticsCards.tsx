import type { RoleStats } from "../../types/management";
import { ManagementStatsLoadingState } from "../ui/LoadingStates";

interface StatisticsCardsProps {
  stats: RoleStats;
  loading?: boolean;
}

export default function StatisticsCards({
  stats,
  loading = false,
}: StatisticsCardsProps) {
  if (loading) {
    return <ManagementStatsLoadingState />;
  }
  const statisticsData = [
    { title: "Super Admins", value: stats.superAdmin },
    { title: "Administrators", value: stats.administrators },
    { title: "Leaders", value: stats.leaders },
    { title: "Guest Experts", value: stats.guestExperts },
    { title: "Participants", value: stats.participants },
    { title: "@Cloud Co-workers", value: stats.atCloudLeaders },
  ];

  // Hairline dividers come from the 1px gaps showing the grid background.
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-gray-200/80 bg-gray-200/70 shadow-sm sm:grid-cols-4">
      <div className="col-span-2 flex flex-col justify-center bg-white px-5 py-4 sm:col-span-1 sm:row-span-2">
        <p className="text-sm font-medium text-gray-500">Total Users</p>
        <p className="mt-1 font-display text-4xl font-semibold tabular-nums text-gray-900">
          {stats.total}
        </p>
      </div>
      {statisticsData.map((stat) => (
        <div className="min-w-0 bg-white px-4 py-4" key={stat.title}>
          <p className="whitespace-nowrap text-[13px] text-gray-500">{stat.title}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-gray-900">
            {stat.value}
          </p>
        </div>
      ))}
    </div>
  );
}
