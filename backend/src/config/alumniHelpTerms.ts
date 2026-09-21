import { createHash } from "crypto";

export interface AlumniHelpTermDocument {
  readonly version: string;
  readonly text: string;
  readonly effectiveAt: string;
  readonly documentHash: string;
}

function document(
  version: string,
  text: string,
  effectiveAt: string,
): AlumniHelpTermDocument {
  return Object.freeze({
    version,
    text,
    effectiveAt,
    documentHash: createHash("sha256")
      .update(text.normalize("NFC"), "utf8")
      .digest("hex"),
  });
}

export const ALUMNI_HELP_CONSENT_REGISTRY = Object.freeze([
  document(
    "alumni-help-consent-v1",
    "I consent to share the information I submit in this help request with the selected alumni helper so they can respond to my request.",
    "2026-09-12T00:00:00.000Z",
  ),
  document(
    "alumni-help-consent-v2",
    "I consent to @Cloud sharing my selected help type, opening note, profile identity, private Alumni Help Room messages, and recorded outcome with the selected alumni helper. @Cloud may use these records to operate the request workflow, deliver related notifications, confirm the outcome, and apply the retention periods described in Privacy & Data Use. I will avoid including information that is not needed for this request.",
    "2026-09-18T00:00:00.000Z",
  ),
] as const);

export const ALUMNI_HELP_DISCLAIMER_REGISTRY = Object.freeze([
  document(
    "alumni-help-disclaimer-v1",
    "@Cloud facilitates alumni connections but does not guarantee advice, introductions, referrals, interviews, employment, or any other outcome.",
    "2026-09-12T00:00:00.000Z",
  ),
  document(
    "alumni-help-disclaimer-v2",
    "@Cloud facilitates voluntary alumni connections. Alumni helpers act in their personal capacity, and each participant decides what assistance is appropriate in the private conversation. @Cloud does not guarantee the accuracy or suitability of advice, an introduction or formal employee referral, an interview, employment, or any other outcome. Do not share passwords, government identification numbers, financial account details, or other unnecessary sensitive information.",
    "2026-09-18T00:00:00.000Z",
  ),
] as const);

export const ALUMNI_HELP_TERMS = Object.freeze({
  consent:
    ALUMNI_HELP_CONSENT_REGISTRY[ALUMNI_HELP_CONSENT_REGISTRY.length - 1]!,
  disclaimer:
    ALUMNI_HELP_DISCLAIMER_REGISTRY[
      ALUMNI_HELP_DISCLAIMER_REGISTRY.length - 1
    ]!,
});

export const ALUMNI_HELP_CONSENT_VERSION = ALUMNI_HELP_TERMS.consent.version;
export const ALUMNI_HELP_CONSENT_TEXT = ALUMNI_HELP_TERMS.consent.text;
export const ALUMNI_HELP_DISCLAIMER_VERSION =
  ALUMNI_HELP_TERMS.disclaimer.version;
export const ALUMNI_HELP_DISCLAIMER_TEXT = ALUMNI_HELP_TERMS.disclaimer.text;
export const ALUMNI_HELP_CONSENT_DOCUMENT_HASH =
  ALUMNI_HELP_TERMS.consent.documentHash;
export const ALUMNI_HELP_DISCLAIMER_DOCUMENT_HASH =
  ALUMNI_HELP_TERMS.disclaimer.documentHash;

export function findAlumniHelpConsent(
  version: string,
): AlumniHelpTermDocument | undefined {
  return ALUMNI_HELP_CONSENT_REGISTRY.find((entry) => entry.version === version);
}

export function findAlumniHelpDisclaimer(
  version: string,
): AlumniHelpTermDocument | undefined {
  return ALUMNI_HELP_DISCLAIMER_REGISTRY.find(
    (entry) => entry.version === version,
  );
}
