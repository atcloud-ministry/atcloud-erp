import { useState, useEffect } from "react";
import {
  ComputerDesktopIcon,
  ExclamationTriangleIcon,
  ClockIcon,
  ChartBarIcon,
  CheckCircleIcon,
  ServerIcon,
  GlobeAltIcon,
  UserGroupIcon,
} from "@heroicons/react/24/outline";
import PageHeader from "../components/ui/PageHeader";
import AlumniNetworkModeControl from "../components/system/AlumniNetworkModeControl";
import { useRuntimeConfig } from "../contexts/RuntimeConfigContext";

interface MonitorStats {
  totalRequestsLastHour: number;
  totalRequestsLastMinute: number;
  requestsPerSecond: number;
  // New enriched metrics from backend
  globalUniqueIPsLastHour?: number;
  globalUniqueUserAgentsLastHour?: number;
  errorsLastHour?: number;
  errorRateLastHour?: number;
  endpointMetrics: Array<{
    endpoint: string;
    count: number;
    averageResponseTime: number;
    errorCount: number;
    uniqueIPs: number;
    uniqueUserAgents: number;
  }>;
  topIPs: Array<{ ip: string; count: number }>;
  topUserAgents: Array<{ userAgent: string; count: number }>;
  suspiciousPatterns: Array<{
    type: string;
    description: string;
    severity: string;
  }>;
}

interface HealthStatus {
  healthy: boolean;
  requestsPerSecond: number;
  requestsLastMinute: number;
  suspiciousPatterns: number;
}

interface RateLimitingStatus {
  enabled: boolean;
  status: "enabled" | "emergency_disabled";
}

export default function SystemMonitor() {
  const { refresh: refreshRuntimeConfig } = useRuntimeConfig();
  const [stats, setStats] = useState<MonitorStats | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [rateLimitingStatus, setRateLimitingStatus] =
    useState<RateLimitingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"disable" | "enable">(
    "disable"
  );
  const [showNotification, setShowNotification] = useState(false);
  const [notificationMessage, setNotificationMessage] = useState("");
  const [notificationType, setNotificationType] = useState<"success" | "error">(
    "success"
  );

  const fetchMonitorData = async () => {
    try {
      setLoading(true);
      setError(null);

      // Get auth token from localStorage
      const token = localStorage.getItem("authToken");

      if (!token) {
        throw new Error("Authentication required. Please log in.");
      }

      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };

      // Fetch health status
      const healthResponse = await fetch(
        `${import.meta.env.VITE_API_URL}/monitor/health`,
        { headers }
      );
      if (!healthResponse.ok) {
        throw new Error("Failed to fetch health data");
      }
      const healthData = await healthResponse.json();
      if (healthData.success) {
        setHealth({
          healthy: healthData.healthy,
          requestsPerSecond: healthData.requestsPerSecond,
          requestsLastMinute: healthData.requestsLastMinute,
          suspiciousPatterns: healthData.suspiciousPatterns,
        });
      }

      // Fetch detailed stats
      const statsResponse = await fetch(
        `${import.meta.env.VITE_API_URL}/monitor/stats`,
        { headers }
      );
      if (statsResponse.ok) {
        const statsData = await statsResponse.json();
        if (statsData.success) {
          setStats(statsData.data);
        }
      }

      // Fetch rate limiting status
      const rateLimitResponse = await fetch(
        `${import.meta.env.VITE_API_URL}/monitor/rate-limiting-status`,
        { headers }
      );
      if (rateLimitResponse.ok) {
        const rateLimitData = await rateLimitResponse.json();
        if (rateLimitData.success) {
          setRateLimitingStatus(rateLimitData.data);
        }
      }
    } catch (err) {
      console.error("Monitor fetch error:", err);
      setError("Failed to fetch monitoring data");
    } finally {
      setLoading(false);
    }
  };

  const showCustomNotification = (
    message: string,
    type: "success" | "error"
  ) => {
    // Clear any existing notification first
    setShowNotification(false);

    // Small delay to allow fade-out, then show new notification
    setTimeout(() => {
      setNotificationMessage(message);
      setNotificationType(type);
      setShowNotification(true);

      // Auto-hide after 5 seconds
      setTimeout(() => {
        setShowNotification(false);
      }, 5000);
    }, 100);
  };

  const handleRateLimitingToggle = () => {
    if (!rateLimitingStatus) return;

    const action = rateLimitingStatus.enabled ? "disable" : "enable";
    setConfirmAction(action);
    setShowConfirmDialog(true);
  };

  const confirmRateLimitingToggle = async () => {
    try {
      // Get auth token from localStorage
      const token = localStorage.getItem("authToken");

      if (!token) {
        throw new Error("Authentication required. Please log in.");
      }

      const endpoint =
        confirmAction === "disable"
          ? `${import.meta.env.VITE_API_URL}/monitor/emergency-disable`
          : `${import.meta.env.VITE_API_URL}/monitor/emergency-enable`;

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await response.json();

      if (data.success) {
        const message =
          confirmAction === "disable"
            ? "🚨 Rate limiting has been emergency disabled!"
            : "✅ Rate limiting has been re-enabled!";
        showCustomNotification(message, "success");
        fetchMonitorData(); // Refresh data
      } else {
        const errorMsg =
          confirmAction === "disable"
            ? "Failed to disable rate limiting"
            : "Failed to enable rate limiting";
        showCustomNotification(errorMsg, "error");
      }
    } catch (err) {
      const errorMsg =
        confirmAction === "disable"
          ? "Error disabling rate limiting"
          : "Error enabling rate limiting";
      showCustomNotification(errorMsg, "error");
      console.error("Rate limiting toggle error:", err);
    } finally {
      setShowConfirmDialog(false);
    }
  };

  useEffect(() => {
    fetchMonitorData();
  }, []);

  useEffect(() => {
    if (autoRefresh) {
      const interval = setInterval(fetchMonitorData, 30000); // Refresh every 30 seconds
      return () => clearInterval(interval);
    }
  }, [autoRefresh]);

  // Derived UI state: error-rate severity badge
  const errorRate = stats?.errorRateLastHour ?? 0;
  const errorRatePct = (errorRate * 100).toFixed(2);
  const errorRateBadgeClass =
    errorRate < 0.01
      ? "bg-green-100 text-green-800"
      : errorRate < 0.05
      ? "bg-yellow-100 text-yellow-800"
      : "bg-red-100 text-red-800";
  const errorRateLabel =
    errorRate < 0.01 ? "Low" : errorRate < 0.05 ? "Elevated" : "High";

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <ComputerDesktopIcon className="mx-auto h-12 w-12 text-gray-400" />
          <h3 className="mt-2 text-sm font-medium text-gray-900">
            Loading System Monitor...
          </h3>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <ExclamationTriangleIcon className="mx-auto h-12 w-12 text-red-400" />
          <h3 className="mt-2 text-sm font-medium text-gray-900">
            Monitor Error
          </h3>
          <p className="mt-1 text-sm text-gray-500">{error}</p>
          <button
            onClick={fetchMonitorData}
            className="mt-4 bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const getHealthStatusColor = () => {
    if (!health) return "text-gray-500";
    return health.healthy ? "text-green-500" : "text-red-500";
  };

  const getHealthStatusIcon = () => {
    if (!health) return <ClockIcon className="h-5 w-5" />;
    return health.healthy ? (
      <CheckCircleIcon className="h-5 w-5" />
    ) : (
      <ExclamationTriangleIcon className="h-5 w-5" />
    );
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <PageHeader
        title="System Monitor"
        subtitle="Real-time server monitoring and analytics dashboard"
      />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <AlumniNetworkModeControl
          onRuntimeConfigRefresh={refreshRuntimeConfig}
        />

        {/* Header Controls */}
        <div className="mb-6 flex justify-between items-center">
          <div className="flex items-center space-x-4">
            <button
              onClick={fetchMonitorData}
              className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600 transition-colors"
            >
              Refresh Data
            </button>
            <label className="flex items-center space-x-2">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="form-checkbox h-4 w-4 text-blue-600"
              />
              <span className="text-sm text-gray-700">Auto-refresh (30s)</span>
            </label>
          </div>

          <button
            onClick={handleRateLimitingToggle}
            className={`px-4 py-2 rounded transition-colors ${
              rateLimitingStatus?.enabled
                ? "bg-red-500 text-white hover:bg-red-600"
                : "bg-green-500 text-white hover:bg-green-600"
            }`}
            disabled={!rateLimitingStatus}
          >
            {rateLimitingStatus?.enabled
              ? "🚨 Emergency: Disable Rate Limiting"
              : "✅ Recovery: Enable Rate Limiting"}
          </button>
        </div>

        {/* Health Status */}
        <div
          className={`mb-6 p-4 rounded-lg border-2 ${
            health?.healthy
              ? "bg-green-50 border-green-200"
              : "bg-red-50 border-red-200"
          }`}
        >
          <div className="flex items-center">
            <div className={getHealthStatusColor()}>
              {getHealthStatusIcon()}
            </div>
            <h3
              className={`ml-2 text-lg font-medium ${getHealthStatusColor()}`}
            >
              System {health?.healthy ? "Healthy" : "Alert"}
            </h3>
          </div>
          {health && (
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
              <div>
                Requests/sec:{" "}
                <span className="font-semibold">
                  {health.requestsPerSecond}
                </span>
              </div>
              <div>
                Requests/min:{" "}
                <span className="font-semibold">
                  {health.requestsLastMinute}
                </span>
              </div>
              <div>
                Suspicious patterns:{" "}
                <span className="font-semibold">
                  {health.suspiciousPatterns}
                </span>
              </div>
              <div>
                Rate Limiting:{" "}
                <span
                  className={`font-semibold ${
                    rateLimitingStatus?.enabled
                      ? "text-green-600"
                      : "text-red-600"
                  }`}
                >
                  {rateLimitingStatus?.enabled ? "Active" : "DISABLED"}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Stats Overview */}
        {stats && (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 mb-8">
            <div className="bg-white p-6 rounded-lg shadow">
              <div className="flex items-center">
                <ChartBarIcon className="h-8 w-8 text-blue-500" />
                <div className="ml-4">
                  <p className="text-sm font-medium text-gray-500">Last Hour</p>
                  <p className="text-2xl font-semibold text-gray-900">
                    {stats.totalRequestsLastHour}
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-white p-6 rounded-lg shadow">
              <div className="flex items-center">
                <ClockIcon className="h-8 w-8 text-green-500" />
                <div className="ml-4">
                  <p className="text-sm font-medium text-gray-500">
                    Last Minute
                  </p>
                  <p className="text-2xl font-semibold text-gray-900">
                    {stats.totalRequestsLastMinute}
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-white p-6 rounded-lg shadow">
              <div className="flex items-center">
                <ServerIcon className="h-8 w-8 text-yellow-500" />
                <div className="ml-4">
                  <p className="text-sm font-medium text-gray-500">
                    Requests/Second
                  </p>
                  <p className="text-2xl font-semibold text-gray-900">
                    {stats.requestsPerSecond}
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-white p-6 rounded-lg shadow">
              <div className="flex items-center">
                <ExclamationTriangleIcon
                  className={`h-8 w-8 ${
                    stats.suspiciousPatterns.length > 0
                      ? "text-red-500"
                      : "text-gray-300"
                  }`}
                />
                <div className="ml-4">
                  <p className="text-sm font-medium text-gray-500">
                    Suspicious Patterns
                  </p>
                  <p className="text-2xl font-semibold text-gray-900">
                    {stats.suspiciousPatterns.length}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Enriched Metrics Overview (Uniques + Error Rate) */}
        {stats && (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 mb-8">
            <div className="bg-white p-6 rounded-lg shadow">
              <div className="flex items-center">
                <GlobeAltIcon className="h-8 w-8 text-indigo-500" />
                <div className="ml-4">
                  <p className="text-sm font-medium text-gray-500">
                    Unique IPs (1h)
                  </p>
                  <p className="text-2xl font-semibold text-gray-900">
                    {stats.globalUniqueIPsLastHour ?? 0}
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-white p-6 rounded-lg shadow">
              <div className="flex items-center">
                <UserGroupIcon className="h-8 w-8 text-purple-500" />
                <div className="ml-4">
                  <p className="text-sm font-medium text-gray-500">
                    Unique User Agents (1h)
                  </p>
                  <p className="text-2xl font-semibold text-gray-900">
                    {stats.globalUniqueUserAgentsLastHour ?? 0}
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-white p-6 rounded-lg shadow">
              <div className="flex items-center">
                <ExclamationTriangleIcon className="h-8 w-8 text-orange-500" />
                <div className="ml-4">
                  <p className="text-sm font-medium text-gray-500">
                    Errors (1h)
                  </p>
                  <p className="text-2xl font-semibold text-gray-900">
                    {stats.errorsLastHour ?? 0}
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-white p-6 rounded-lg shadow">
              <div className="flex items-center">
                <ChartBarIcon className="h-8 w-8 text-rose-500" />
                <div className="ml-4">
                  <p className="text-sm font-medium text-gray-500">
                    Error Rate (1h)
                  </p>
                  <p className="text-2xl font-semibold text-gray-900">
                    {errorRatePct}%
                  </p>
                  <div
                    className={`mt-1 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${errorRateBadgeClass}`}
                    aria-label={`Error rate severity: ${errorRateLabel}`}
                    title="Auth 401/403 are excluded from error rate"
                  >
                    {errorRateLabel}
                  </div>
                  <p className="mt-1 text-xs text-gray-500">
                    Excludes expected auth 401/403
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Suspicious Patterns Alert */}
        {stats && stats.suspiciousPatterns.length > 0 && (
          <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
            <h3 className="text-lg font-medium text-red-800 mb-2">
              🚨 Suspicious Activity Detected
            </h3>
            <div className="space-y-2">
              {stats.suspiciousPatterns.map((pattern, index) => (
                <div
                  key={index}
                  className={`p-2 rounded ${
                    pattern.severity === "HIGH" ? "bg-red-100" : "bg-yellow-100"
                  }`}
                >
                  <span className="font-semibold">{pattern.type}:</span>{" "}
                  {pattern.description}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Top Endpoints */}
          <div className="bg-white rounded-lg shadow">
            <div className="px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-medium text-gray-900">
                Top Endpoints
              </h3>
            </div>
            <div className="p-6">
              {stats && stats.endpointMetrics.length > 0 ? (
                <div className="space-y-3">
                  {stats.endpointMetrics.slice(0, 10).map((endpoint, index) => (
                    <div
                      key={index}
                      className="flex justify-between items-center p-3 bg-gray-50 rounded"
                    >
                      <div className="flex-1">
                        <p className="font-medium text-sm">
                          {endpoint.endpoint}
                        </p>
                        <p className="text-xs text-gray-500">
                          {endpoint.count} requests • avg{" "}
                          {endpoint.averageResponseTime}ms
                        </p>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-semibold">
                          {endpoint.count}
                        </div>
                        {endpoint.errorCount > 0 && (
                          <div className="text-xs text-red-500">
                            {endpoint.errorCount} errors
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-gray-500">No endpoint data available</p>
              )}
            </div>
          </div>

          {/* Top IPs */}
          <div className="bg-white rounded-lg shadow">
            <div className="px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-medium text-gray-900">
                Top IP Addresses
              </h3>
            </div>
            <div className="p-6">
              {stats && stats.topIPs.length > 0 ? (
                <div className="space-y-3">
                  {stats.topIPs.slice(0, 10).map((ip, index) => (
                    <div
                      key={index}
                      className="flex justify-between items-center p-3 bg-gray-50 rounded"
                    >
                      <div className="flex items-center">
                        <GlobeAltIcon className="h-4 w-4 text-gray-400 mr-2" />
                        <span className="font-mono text-sm">{ip.ip}</span>
                      </div>
                      <span className="font-semibold">{ip.count} requests</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-gray-500">No IP data available</p>
              )}
            </div>
          </div>

          {/* Top User Agents */}
          <div className="bg-white rounded-lg shadow lg:col-span-2">
            <div className="px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-medium text-gray-900">
                Top User Agents
              </h3>
            </div>
            <div className="p-6">
              {stats && stats.topUserAgents.length > 0 ? (
                <div className="space-y-3">
                  {stats.topUserAgents.slice(0, 5).map((ua, index) => (
                    <div
                      key={index}
                      className="flex justify-between items-start p-3 bg-gray-50 rounded"
                    >
                      <div className="flex items-start flex-1">
                        <UserGroupIcon className="h-4 w-4 text-gray-400 mr-2 mt-0.5" />
                        <span className="text-sm break-all">
                          {ua.userAgent}
                        </span>
                      </div>
                      <span className="font-semibold ml-4">
                        {ua.count} requests
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-gray-500">No user agent data available</p>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-8 text-center text-sm text-gray-500">
          Last updated: {new Date().toLocaleString()}
          {autoRefresh && (
            <span className="ml-2">• Auto-refreshing every 30 seconds</span>
          )}
        </div>
      </div>

      {/* Custom Confirmation Dialog */}
      {showConfirmDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
            <div className="flex items-center mb-4">
              <ExclamationTriangleIcon className="h-8 w-8 text-orange-500 mr-3" />
              <h3 className="text-lg font-semibold text-gray-900">
                {confirmAction === "disable"
                  ? "Emergency Disable"
                  : "Recovery Enable"}{" "}
                Rate Limiting
              </h3>
            </div>

            <div className="mb-6">
              <p className="text-gray-700 mb-3">
                {confirmAction === "disable"
                  ? "⚠️ You are about to DISABLE rate limiting completely. This will allow unlimited requests to the server."
                  : "✅ You are about to RE-ENABLE rate limiting. This will restore normal traffic protection."}
              </p>
              <p className="text-sm text-gray-600">
                {confirmAction === "disable"
                  ? "This should only be done during emergency situations when legitimate users are being blocked."
                  : "Rate limiting helps protect the server from abuse and ensures fair usage."}
              </p>
            </div>

            <div className="flex justify-end space-x-3">
              <button
                onClick={() => setShowConfirmDialog(false)}
                className="px-4 py-2 text-gray-700 bg-gray-200 rounded hover:bg-gray-300 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmRateLimitingToggle}
                className={`px-4 py-2 rounded transition-colors ${
                  confirmAction === "disable"
                    ? "bg-red-500 text-white hover:bg-red-600"
                    : "bg-green-500 text-white hover:bg-green-600"
                }`}
              >
                {confirmAction === "disable" ? "🚨 Disable" : "✅ Enable"} Rate
                Limiting
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Custom Notification */}
      {showNotification && (
        <div className="fixed top-4 right-4 z-50 animate-fade-in-slide">
          <div
            className={`rounded-lg p-4 shadow-xl border-l-4 max-w-md backdrop-blur-sm ${
              notificationType === "success"
                ? "bg-green-50/95 border-green-400 text-green-800"
                : "bg-red-50/95 border-red-400 text-red-800"
            }`}
          >
            <div className="flex items-center">
              <div className="flex-shrink-0">
                {notificationType === "success" ? (
                  <CheckCircleIcon className="h-6 w-6 text-green-500" />
                ) : (
                  <ExclamationTriangleIcon className="h-6 w-6 text-red-500" />
                )}
              </div>
              <div className="ml-3 flex-1">
                <p className="text-sm font-semibold">{notificationMessage}</p>
                <p className="text-xs mt-1 opacity-75">
                  {notificationType === "success"
                    ? "Action completed successfully"
                    : "Action failed"}
                </p>
              </div>
              <div className="ml-4">
                <button
                  onClick={() => setShowNotification(false)}
                  className={`inline-flex rounded-full p-1.5 text-sm hover:scale-110 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                    notificationType === "success"
                      ? "text-green-600 hover:bg-green-200/50 focus:ring-green-500"
                      : "text-red-600 hover:bg-red-200/50 focus:ring-red-500"
                  }`}
                >
                  <span className="sr-only">Dismiss</span>
                  <svg
                    className="h-4 w-4"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                      clipRule="evenodd"
                    />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
