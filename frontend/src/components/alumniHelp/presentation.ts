import type {
  AlumniHelpAvailableAction,
  AlumniHelpLifecycleAction,
  AlumniHelpOutcomeCode,
  AlumniHelpRequestStatus,
  AlumniHelpType,
  DirectoryDetailDTO,
} from "../../services/api";

export function enabledHelpTypes(
  profile: Pick<DirectoryDetailDTO, "helpOfferings">,
): AlumniHelpType[] {
  const types: AlumniHelpType[] = [];
  if (profile.helpOfferings.careerAdvice) types.push("career_advice");
  if (profile.helpOfferings.warmIntroduction) types.push("warm_introduction");
  if (profile.helpOfferings.formalEmployeeReferral) {
    types.push("formal_employee_referral");
  }
  return types;
}

export function hasEnabledHelpOffering(
  profile: Pick<DirectoryDetailDTO, "helpOfferings">,
): boolean {
  return enabledHelpTypes(profile).length > 0;
}

export const HELP_TYPE_LABELS: Readonly<Record<AlumniHelpType, string>> = {
  career_advice: "Career Advice",
  warm_introduction: "Warm Introduction",
  formal_employee_referral: "Formal Employee Referral",
};

export const HELP_STATUS_LABELS: Readonly<
  Record<AlumniHelpRequestStatus, string>
> = {
  requested: "Requested",
  needs_information: "Needs information",
  alternative_proposed: "Alternative proposed",
  accepted: "Accepted",
  declined: "Declined",
  withdrawn: "Withdrawn",
  in_progress: "In progress",
  completed: "Help marked complete",
  closed: "Closed",
};

export const LIFECYCLE_ACTION_LABELS: Readonly<
  Record<AlumniHelpLifecycleAction, string>
> = {
  create: "Request created",
  request_information: "Requested more information",
  provide_information: "Provided information",
  propose_alternative: "Proposed an alternative",
  confirm_alternative: "Confirmed the alternative",
  reject_alternative: "Rejected the alternative",
  accept: "Accepted the request",
  decline: "Declined the request",
  withdraw: "Withdrew the request",
  start: "Marked help in progress",
  complete: "Marked help complete",
  close: "Closed the request",
  outcome_confirm: "Confirmed result and closed the request",
  outcome_auto_confirm: "Automatically confirmed result and closed the request",
  outcome_reconcile: "Reconciled confirmed result and closed the request",
};

export const ACTION_LABELS: Readonly<
  Record<AlumniHelpAvailableAction, string>
> = {
  request_information: "Request information",
  provide_information: "Provide information",
  propose_alternative: "Propose alternative",
  confirm_alternative: "Confirm alternative",
  reject_alternative: "Reject alternative",
  accept: "Accept",
  decline: "Decline",
  withdraw: "Withdraw request",
  start: "Mark in progress",
  complete: "Mark help complete",
  close: "Close request",
  submit_outcome: "Record result",
  resubmit_outcome: "Submit revised result",
  confirm_outcome: "Confirm result",
  deny_outcome: "Deny result",
};

export const OUTCOME_LABELS: Readonly<
  Record<AlumniHelpType, Readonly<Partial<Record<AlumniHelpOutcomeCode, string>>>>
> = {
  career_advice: {
    not_fulfilled: "Career Advice did not take place",
    completed: "Career Advice completed",
  },
  warm_introduction: {
    not_fulfilled: "Warm Introduction did not take place",
    completed: "Warm Introduction completed",
  },
  formal_employee_referral: {
    not_fulfilled: "Formal Employee Referral did not take place",
    interview_not_hired:
      "Formal Employee Referral led to an interview, but not a hire",
    hired_after_interview:
      "Formal Employee Referral led to an interview and a hire",
  },
};

export function outcomeLabel(
  helpType: AlumniHelpType,
  outcomeCode: AlumniHelpOutcomeCode,
): string {
  return OUTCOME_LABELS[helpType][outcomeCode] ?? outcomeCode;
}

export function outcomeOptions(helpType: AlumniHelpType) {
  return Object.entries(OUTCOME_LABELS[helpType]).map(([value, label]) => ({
    value: value as AlumniHelpOutcomeCode,
    label: label as string,
  }));
}

export function formatHelpDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
