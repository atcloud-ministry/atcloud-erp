import { createHash } from "crypto";

const text =
  "I understand that @Cloud uses the account and profile information I provide to create and secure my account, operate programs and community features I choose to use, communicate service information, and produce privacy-protected aggregate reporting. My account profile is available only according to authenticated role permissions; joining the Alumni Directory requires a separate publication consent. Retention and communication choices are described in Privacy & Data Use.";

export const REGISTRATION_PRIVACY_NOTICE = Object.freeze({
  version: "registration-privacy-v1",
  text,
  effectiveAt: "2026-09-18T00:00:00.000Z",
  documentHash: createHash("sha256")
    .update(text.normalize("NFC"), "utf8")
    .digest("hex"),
});
