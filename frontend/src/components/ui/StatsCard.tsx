import React from "react";

interface StatsCardProps {
  title: string;
  value: string | number;
  icon: React.ReactNode;
  trend?: {
    value: number;
    label: string;
    isPositive?: boolean;
  };
  color?:
    | "blue"
    | "green"
    | "yellow"
    | "red"
    | "purple"
    | "gray"
    | "orange"
    | "aquamarine";
  className?: string;
}

const colorClasses = {
  blue: { bg: "bg-blue-50", text: "text-blue-700", value: "text-blue-900" },
  green: { bg: "bg-green-50", text: "text-green-700", value: "text-green-900" },
  yellow: {
    bg: "bg-yellow-50",
    text: "text-yellow-800",
    value: "text-yellow-900",
  },
  red: { bg: "bg-red-50", text: "text-red-700", value: "text-red-900" },
  purple: {
    bg: "bg-purple-50",
    text: "text-purple-700",
    value: "text-purple-900",
  },
  orange: {
    bg: "bg-orange-50",
    text: "text-orange-700",
    value: "text-orange-900",
  },
  aquamarine: {
    bg: "bg-cyan-50",
    text: "text-cyan-800",
    value: "text-cyan-900",
  },
  gray: { bg: "bg-gray-50", text: "text-gray-700", value: "text-gray-900" },
};

export function StatsCard({
  title,
  value,
  icon,
  trend,
  color = "gray",
  className = "",
}: StatsCardProps) {
  const colors = colorClasses[color];

  return (
    <div className={`${colors.bg} rounded-lg p-4 ${className}`}>
      <div className="flex items-center">
        <div className="flex-shrink-0">
          <div className={`h-8 w-8 ${colors.text}`}>{icon}</div>
        </div>
        <div className="ml-3">
          <p className={`text-sm font-medium ${colors.text}`}>{title}</p>
          <div className="flex items-baseline">
            <p className={`text-2xl font-bold ${colors.value}`}>{value}</p>
            {trend && (
              <p
                className={`ml-2 text-sm ${
                  trend.isPositive ? "text-green-700" : "text-red-700"
                }`}
              >
                {trend.isPositive ? "+" : ""}
                {trend.value}% {trend.label}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface StatsGridProps {
  children: React.ReactNode;
  columns?: 1 | 2 | 3 | 4 | 5 | 6;
  className?: string;
}

export function StatsGrid({
  children,
  columns = 3,
  className = "",
}: StatsGridProps) {
  const gridCols = {
    1: "grid-cols-1",
    2: "grid-cols-1 md:grid-cols-2",
    3: "grid-cols-1 md:grid-cols-3",
    4: "grid-cols-1 md:grid-cols-2 lg:grid-cols-4",
    5: "grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5",
    6: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6",
  };

  return (
    <div className={`grid ${gridCols[columns]} gap-4 ${className}`}>
      {children}
    </div>
  );
}
