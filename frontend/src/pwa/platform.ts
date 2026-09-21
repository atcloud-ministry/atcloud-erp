export interface NavigatorPlatformDetails {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  standalone?: boolean;
}

export interface DisplayModeQuery {
  matches: boolean;
}

export function isAppleMobilePlatform({
  userAgent,
  platform = "",
  maxTouchPoints = 0,
}: NavigatorPlatformDetails): boolean {
  return (
    /iPad|iPhone|iPod/i.test(userAgent) ||
    (platform === "MacIntel" && maxTouchPoints > 1)
  );
}

export function isStandaloneDisplay(
  navigatorDetails: NavigatorPlatformDetails,
  displayMode?: DisplayModeQuery | null,
): boolean {
  return navigatorDetails.standalone === true || displayMode?.matches === true;
}

export function shouldOfferAppleHomeScreenInstall(
  navigatorDetails: NavigatorPlatformDetails,
  displayMode?: DisplayModeQuery | null,
): boolean {
  return (
    isAppleMobilePlatform(navigatorDetails) &&
    !isStandaloneDisplay(navigatorDetails, displayMode)
  );
}
