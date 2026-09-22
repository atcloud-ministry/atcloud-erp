import { useEffect } from "react";
import { useLocation } from "react-router-dom";

const PRODUCT_TITLE = "@Cloud ERP";

const ROUTE_TITLES: readonly [RegExp, string][] = [
  [/^\/$/, "Home"],
  [/^\/signup\/?$/i, "Create Account"],
  [/^\/privacy\/?$/i, "Privacy & Data Use"],
  [/^\/login\/?$/i, "Sign In"],
  [/^\/check-email\/?$/i, "Check Your Email"],
  [/^\/verify-email\//i, "Email Verification"],
  [/^\/reset-password\//i, "Reset Password"],
  [/^\/change-password\/confirm\//i, "Confirm Password Change"],
  [/^\/guest-register\//i, "Guest Registration"],
  [/^\/guest-confirmation\/?$/i, "Guest Confirmation"],
  [/^\/guest-manage\//i, "Manage Guest Registration"],
  [/^\/guest\/decline\//i, "Decline Guest Invitation"],
  [/^\/assignments\/reject\/?$/i, "Decline Assignment"],
  [/^\/dashboard\/community\/alumni\/me\/?$/i, "My Alumni Profile"],
  [/^\/dashboard\/community\/alumni\/[^/]+\/?$/i, "Alumni Profile"],
  [/^\/dashboard\/community\/alumni\/?$/i, "Alumni Directory"],
  [/^\/dashboard\/community\/help-requests\/[^/]+\/?$/i, "Alumni Help Request"],
  [/^\/dashboard\/community\/help-requests\/?$/i, "Alumni Help Requests"],
  [/^\/dashboard\/community\/members\/?$/i, "Community Members"],
  [/^\/dashboard\/chat-rooms\/[^/]+\/?$/i, "Chat Room"],
  [/^\/dashboard\/chat-rooms\/?$/i, "Chat Rooms"],
  [/^\/dashboard\/admin\/users\/?$/i, "User Management"],
  [/^\/dashboard\/notification-settings\/?$/i, "Notification Settings"],
  [/^\/dashboard\/system-messages\/?$/i, "System Messages"],
  [/^\/dashboard\/profile\/[^/]+\/?$/i, "Member Profile"],
  [/^\/dashboard\/profile\/?$/i, "My Profile"],
  [/^\/dashboard\/programs\/new\/?$/i, "Create Program"],
  [/^\/dashboard\/programs\/[^/]+\/edit\/?$/i, "Edit Program"],
  [/^\/dashboard\/programs\/[^/]+\/enroll\/?$/i, "Program Enrollment"],
  [/^\/dashboard\/programs\/[^/]+\/?$/i, "Program Details"],
  [/^\/dashboard\/programs\/?$/i, "Programs"],
  [/^\/dashboard\/annual-memberships\/new\/?$/i, "Create Annual Membership"],
  [/^\/dashboard\/annual-memberships\/[^/]+\/edit\/?$/i, "Edit Annual Membership"],
  [/^\/dashboard\/annual-memberships\/[^/]+\/?$/i, "Annual Membership Details"],
  [/^\/dashboard\/annual-memberships\/?$/i, "Annual Memberships"],
  [/^\/dashboard\/purchase-history\/?$/i, "Purchase History"],
  [/^\/dashboard\/(?:purchase-receipt|purchases)\/[^/]+(?:\/receipt)?\/?$/i, "Purchase Receipt"],
  [/^\/dashboard\/purchase\/success\/?$/i, "Purchase Complete"],
  [/^\/dashboard\/purchase\/cancel\/?$/i, "Purchase Cancelled"],
  [/^\/dashboard\/income-history\/?$/i, "Income History"],
  [/^\/dashboard\/refund-requests\/[^/]+\/approval\/?$/i, "Refund Approval"],
  [/^\/dashboard\/refund-requests\/[^/]+\/decision\/?$/i, "Refund Decision"],
  [/^\/dashboard\/new-event\/?$/i, "Create Event"],
  [/^\/dashboard\/edit-event\/[^/]+\/?$/i, "Edit Event"],
  [/^\/dashboard\/published-events\/?$/i, "Published Events"],
  [/^\/dashboard\/upcoming\/?$/i, "Upcoming Events"],
  [/^\/dashboard\/passed\/?$/i, "Past Events"],
  [/^\/dashboard\/my-events\/?$/i, "My Events"],
  [/^\/dashboard\/admin\/promo-codes\/[^/]+\/?$/i, "Promo Code Details"],
  [/^\/dashboard\/(?:admin\/)?promo-codes\/?$/i, "Promo Codes"],
  [/^\/dashboard\/(?:configure|create|edit|view)-roles-template(?:s)?(?:\/[^/]+)?\/?$/i, "Role Templates"],
  [/^\/dashboard\/donation-receipt\/?$/i, "Donation Receipt"],
  [/^\/dashboard\/donate\/?$/i, "Donate"],
  [/^\/dashboard\/change-password\/?$/i, "Change Password"],
  [/^\/dashboard\/get-involved\/?$/i, "Get Involved"],
  [/^\/dashboard\/feedback\/?$/i, "Feedback"],
  [/^\/dashboard\/(?:welcome|emba-program)\/?$/i, "EMBA Program"],
  [/^\/dashboard\/analytics\/?$/i, "Analytics"],
  [/^\/dashboard\/audit-logs\/?$/i, "Audit Logs"],
  [/^\/dashboard\/monitor\/?$/i, "System Monitor"],
  [/^\/dashboard\/management\/?$/i, "Community"],
  [/^\/dashboard\/?$/i, "Dashboard"],
  [/^\/dashboard\/events\/[^/]+\/purchase\/success\/?$/i, "Event Purchase Complete"],
  [/^\/dashboard\/events\/[^/]+\/purchase\/?$/i, "Event Purchase"],
  [/^\/dashboard\/event\/[^/]+\/?$/i, "Event Details"],
  [/^\/admin\/users(?:\/[^/]+)?\/?$/i, "User Management"],
  [/^\/logout\/?$/i, "Sign Out"],
  [/^\/(?:p|pr|s)\/[^/]+\/?$/i, "Redirect"],
  [/^\/events\/[^/]+\/?$/i, "Event Details"],
  [/^\/events\/?$/i, "Events"],
  [/^\/donate\/?$/i, "Donate"],
];

export function routeDocumentTitle(pathname: string, search = ""): string {
  if (pathname === "/" && new URLSearchParams(search).has("verifyEmailToken")) {
    return `Email Verification | ${PRODUCT_TITLE}`;
  }
  const route = ROUTE_TITLES.find(([pattern]) => pattern.test(pathname));
  return `${route?.[1] ?? "Page"} | ${PRODUCT_TITLE}`;
}

export default function RouteDocumentTitle() {
  const location = useLocation();

  useEffect(() => {
    document.title = routeDocumentTitle(location.pathname, location.search);
  }, [location.pathname, location.search]);

  return null;
}
