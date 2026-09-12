export const ALUMNI_HELP_CONSENT_VERSION =
  "alumni-help-consent-v1" as const;

export const ALUMNI_HELP_CONSENT_TEXT =
  "I consent to share the information I submit in this help request with the selected alumni helper so they can respond to my request." as const;

export const ALUMNI_HELP_DISCLAIMER_VERSION =
  "alumni-help-disclaimer-v1" as const;

export const ALUMNI_HELP_DISCLAIMER_TEXT =
  "@Cloud facilitates alumni connections but does not guarantee advice, introductions, referrals, interviews, employment, or any other outcome." as const;

export const ALUMNI_HELP_CONSENT_DOCUMENT_HASH =
  "d0df645b87c156dd797d82f1838437b5a9227716273e2476b0f4ef9ec1cddd92" as const;

export const ALUMNI_HELP_DISCLAIMER_DOCUMENT_HASH =
  "abb775671f50ca548ed5a60fa9546e42aea30cbce669cbdea158d1d32e2407d7" as const;

export const ALUMNI_HELP_TERMS = Object.freeze({
  consent: Object.freeze({
    version: ALUMNI_HELP_CONSENT_VERSION,
    text: ALUMNI_HELP_CONSENT_TEXT,
    documentHash: ALUMNI_HELP_CONSENT_DOCUMENT_HASH,
  }),
  disclaimer: Object.freeze({
    version: ALUMNI_HELP_DISCLAIMER_VERSION,
    text: ALUMNI_HELP_DISCLAIMER_TEXT,
    documentHash: ALUMNI_HELP_DISCLAIMER_DOCUMENT_HASH,
  }),
});
