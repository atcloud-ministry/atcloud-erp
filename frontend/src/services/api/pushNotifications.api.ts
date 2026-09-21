import { BaseApiClient } from "./common";
import {
  decodeNotificationPreference,
  decodePushPublicConfig,
  decodePushSubscription,
  decodePushSubscriptionList,
  normalizeNotificationPreferenceChanges,
  normalizePushSubscriptionInput,
  requirePushInstallationId,
  type NotificationPreferenceChanges,
  type NotificationPreferenceDTO,
  type PushPublicConfigDTO,
  type PushSubscriptionDTO,
  type PushSubscriptionInput,
  type PushSubscriptionListDTO,
} from "./pushNotifications.contracts";

class PushNotificationsApiClient extends BaseApiClient {
  async getConfig(signal?: AbortSignal): Promise<PushPublicConfigDTO> {
    const response = await this.request<unknown>("/push/config", { signal });
    if (response.data === undefined) {
      throw new Error(response.message || "Failed to load Push configuration");
    }
    return decodePushPublicConfig(response.data);
  }

  async listSubscriptions(
    signal?: AbortSignal,
  ): Promise<PushSubscriptionListDTO> {
    const response = await this.request<unknown>("/push/subscriptions", {
      signal,
    });
    if (response.data === undefined) {
      throw new Error(response.message || "Failed to load Push subscriptions");
    }
    return decodePushSubscriptionList(response.data);
  }

  async upsertSubscription(
    input: PushSubscriptionInput,
  ): Promise<PushSubscriptionDTO> {
    const body = normalizePushSubscriptionInput(input);
    const response = await this.request<unknown>("/push/subscriptions", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (response.data === undefined) {
      throw new Error(response.message || "Failed to save Push subscription");
    }
    return decodePushSubscription(response.data);
  }

  async removeSubscription(installationId: string): Promise<void> {
    const encodedInstallationId = encodeURIComponent(
      requirePushInstallationId(installationId),
    );
    await this.request<unknown>(
      `/push/subscriptions/${encodedInstallationId}`,
      { method: "DELETE" },
    );
  }

  async getPreferences(
    signal?: AbortSignal,
  ): Promise<NotificationPreferenceDTO> {
    const response = await this.request<unknown>("/push/preferences", {
      signal,
    });
    if (response.data === undefined) {
      throw new Error(
        response.message || "Failed to load notification preferences",
      );
    }
    return decodeNotificationPreference(response.data);
  }

  async updatePreferences(
    changes: NotificationPreferenceChanges,
  ): Promise<NotificationPreferenceDTO> {
    const body = normalizeNotificationPreferenceChanges(changes);
    const response = await this.request<unknown>("/push/preferences", {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    if (response.data === undefined) {
      throw new Error(
        response.message || "Failed to update notification preferences",
      );
    }
    return decodeNotificationPreference(response.data);
  }
}

export const pushNotificationsService = new PushNotificationsApiClient();
export { PushNotificationsApiClient };
