function SummaryRow({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: string;
}) {
  return (
    <div className="flex justify-between">
      <span className="text-sm text-gray-600">{label}:</span>
      <span className={`font-medium ${accent || ""}`}>{value}</span>
    </div>
  );
}

export interface ChurchAnalytics {
  weeklyChurchStats: Record<string, number>;
  churchAddressStats: Record<string, number>;
  usersWithChurchInfo: number;
  usersWithoutChurchInfo: number;
  totalChurches: number;
  totalChurchLocations: number;
  churchParticipationRate: number;
}

export interface OccupationAnalytics {
  occupationStats: Record<string, number>;
  usersWithOccupation: number;
  usersWithoutOccupation: number;
  totalOccupationTypes: number;
  topOccupations: Array<{ occupation: string; count: number }>;
  occupationCompletionRate: number;
}

export interface ParticipantDemographicsProps {
  churchAnalytics: ChurchAnalytics;
  occupationAnalytics: OccupationAnalytics;
  showOccupation?: boolean;
}

export function ParticipantDemographics({
  churchAnalytics,
  occupationAnalytics,
  showOccupation = true,
}: ParticipantDemographicsProps) {
  return (
    <div
      className={`grid grid-cols-1 gap-6 mb-2 ${
        showOccupation ? "lg:grid-cols-2" : ""
      }`}
    >
      <div className="bg-white border rounded-lg p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">
          Church Statistics
        </h3>
        <div className="space-y-4">
          <SummaryRow
            label="Total Churches"
            value={churchAnalytics.totalChurches}
          />
          <SummaryRow
            label="Church Locations"
            value={churchAnalytics.totalChurchLocations}
          />
          <SummaryRow
            label="Users with Church Info"
            value={churchAnalytics.usersWithChurchInfo}
            accent="text-green-600"
          />
          <SummaryRow
            label="Participation Rate"
            value={`${churchAnalytics.churchParticipationRate.toFixed(1)}%`}
          />
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className="bg-purple-500 h-2 rounded-full"
              style={{
                width: `${churchAnalytics.churchParticipationRate}%`,
              }}
            />
          </div>
          <div className="mt-4">
            <h4 className="text-sm font-medium text-gray-700 mb-2">
              Most Common Churches:
            </h4>
            <div className="space-y-2">
              {Object.entries(churchAnalytics.weeklyChurchStats)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 5)
                .map(([church, count]) => (
                  <div key={church} className="flex justify-between text-xs">
                    <span className="text-gray-600 truncate">{church}</span>
                    <span className="bg-purple-100 text-purple-800 px-2 py-1 rounded-full text-xs font-medium">
                      {count}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      </div>
      {showOccupation && (
        <div className="bg-white border rounded-lg p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            Reportable Occupation Statistics
          </h3>
          <div className="space-y-4">
            <SummaryRow
              label="Reportable Occupations"
              value={occupationAnalytics.totalOccupationTypes}
            />
            <SummaryRow
              label="Users in Reportable Groups"
              value={occupationAnalytics.usersWithOccupation}
              accent="text-green-600"
            />
            <div className="mt-4">
              <h4 className="text-sm font-medium text-gray-700 mb-2">
                Most Common Occupations:
              </h4>
              <div className="space-y-2">
                {occupationAnalytics.topOccupations.map((o) => (
                  <div
                    key={o.occupation}
                    className="flex justify-between text-xs"
                  >
                    <span className="text-gray-600 truncate">
                      {o.occupation}
                    </span>
                    <span className="bg-blue-100 text-blue-800 px-2 py-1 rounded-full text-xs font-medium">
                      {o.count}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
