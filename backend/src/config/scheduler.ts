export function isSchedulerEnabled(
  env: Readonly<{ NODE_ENV?: string; SCHEDULER_ENABLED?: string }> = {
    NODE_ENV: process.env.NODE_ENV,
    SCHEDULER_ENABLED: process.env.SCHEDULER_ENABLED,
  },
): boolean {
  if (env.NODE_ENV === "test") return false;
  if (env.NODE_ENV === "production") {
    return env.SCHEDULER_ENABLED === "true";
  }
  return env.SCHEDULER_ENABLED !== "false";
}
