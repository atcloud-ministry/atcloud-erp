import GettingStartedStep from "./GettingStartedStep";
import { gettingStartedSteps } from "../../config/gettingStartedConfig";
import { useAuth } from "../../hooks/useAuth";
import { useRuntimeConfig } from "../../contexts/RuntimeConfigContext";

export default function GettingStartedSection() {
  const { currentUser } = useAuth();
  const { config: runtimeConfig, status: runtimeConfigStatus } =
    useRuntimeConfig();
  const isGuest = !currentUser;
  const role = currentUser?.role ?? "Participant";

  const resolveLink = (title: string): string | undefined => {
    switch (title) {
      case "Complete Your Profile":
        return "/dashboard/profile";
      case "Explore Community Events":
        return "/dashboard/upcoming";
      case "Connect & Collaborate":
        if (isGuest) return "/login";
        if (
          runtimeConfigStatus === "ready" &&
          runtimeConfig.alumniNetwork.readable
        ) {
          return "/dashboard/community";
        }
        if (["Super Admin", "Administrator", "Leader"].includes(role)) {
          return "/dashboard/management"; // Management / Community
        }
        return "/dashboard/get-involved"; // participant info page
      case "Create Your First Event":
        if (["Super Admin", "Administrator", "Leader"].includes(role)) {
          return "/dashboard/new-event";
        }
        return "/dashboard/get-involved"; // participant alternative path
      default:
        return undefined;
    }
  };

  // Guests only see 2 steps
  const GUEST_TITLES = ["Explore Community Events", "Connect & Collaborate"];
  const visibleSteps = isGuest
    ? gettingStartedSteps.filter((s) => GUEST_TITLES.includes(s.title))
    : gettingStartedSteps;

  return (
    <div className="rounded-2xl border border-gray-200/80 bg-white p-6 shadow-sm">
      <h3 className="mb-5 text-base font-semibold text-gray-900">
        Getting Started with @Cloud
      </h3>
      <div className="grid grid-cols-1 gap-x-8 gap-y-6 md:grid-cols-2">
        {visibleSteps.map((step, index) => (
          <GettingStartedStep
            key={step.stepNumber}
            stepNumber={index + 1}
            title={step.title}
            description={step.description}
            color={step.color}
            to={resolveLink(step.title)}
          />
        ))}
      </div>
    </div>
  );
}
