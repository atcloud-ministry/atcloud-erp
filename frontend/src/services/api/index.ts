/**
 * Central export file for all API services
 *
 * This file is a side-effect-free public API surface. Compatibility names live
 * beside their owning service instead of being reconstructed here.
 */

// Export common types and config
export * from "./common/types";
export { API_BASE_URL } from "./common/config";

// Export all service modules
export * from "./auth.api";
export * from "./feedback.api";
export * from "./guests.api";
export * from "./publicEvents.api";
export * from "./events.api";
export * from "./rolesTemplates.api";
export * from "./programs.api";
export * from "./purchases.api";
export * from "./promoCodes.api";
export * from "./users.api";
export * from "./userDirectory.api";
export * from "./alumniDirectory.api";
export * from "./alumniHelp.api";
export * from "./files.api";
export * from "./notifications.api";
export * from "./systemMessages.api";
export * from "./messages.api";
export * from "./analytics.api";
export * from "./search.api";
export * from "./assignments.api";
export * from "./donations.api";
export * from "./refundRequests.api";
export * from "./annualMemberships.api";
export * from "./alumniInvitations.api";

// Export full ApiClient for backward compatibility with code that uses apiClient instance
export { apiClient, ApiClient } from "./apiClient";

// Default export for default imports
export { apiClient as default } from "./apiClient";
