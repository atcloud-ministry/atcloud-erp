export default function ConnectionStatus({
  connected,
  degraded = false,
  limited = false,
}: {
  connected: boolean;
  degraded?: boolean;
  limited?: boolean;
}) {
  if (connected && !degraded && !limited) return null;
  return (
    <div
      className={`border-b px-4 py-2 text-center text-xs ${
        degraded || limited
          ? "border-amber-200 bg-amber-50 text-amber-900"
          : "border-gray-200 bg-gray-50 text-gray-700"
      }`}
      role="status"
    >
      {limited
        ? "Live updates are paused because this account has too many open tabs. Close another tab, then refresh this page."
        : degraded
        ? "Live updates are unavailable. Messages can still be sent and refreshed."
        : "Reconnecting… Messages will be recovered automatically."}
    </div>
  );
}
