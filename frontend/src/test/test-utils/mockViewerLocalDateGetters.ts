import { vi } from "vitest";

/**
 * Emulate only the viewer-local Date getters used by the display formatter.
 * Changing process.env.TZ inside a Vitest thread does not change that thread's
 * native timezone. Keep real instants and source-zone conversion intact, and
 * derive local calendar parts from Intl with an explicit viewer timezone.
 */
export function mockViewerLocalDateGetters(timeZone: string): () => void {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const getters = {
    getFullYear: "year",
    getMonth: "month",
    getDate: "day",
    getHours: "hour",
    getMinutes: "minute",
  } as const;
  const spies = Object.entries(getters).map(([method, part]) =>
    vi
      .spyOn(Date.prototype, method as keyof typeof getters)
      .mockImplementation(function (this: Date) {
        if (Number.isNaN(this.getTime())) return Number.NaN;
        const value = Number(
          formatter.formatToParts(this).find((item) => item.type === part)?.value,
        );
        return part === "month" ? value - 1 : value;
      }),
  );
  return () => spies.forEach((spy) => spy.mockRestore());
}
