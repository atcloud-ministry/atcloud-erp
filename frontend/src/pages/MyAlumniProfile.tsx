import {
  ArrowPathIcon,
  CheckCircleIcon,
  EyeIcon,
  PencilSquareIcon,
} from "@heroicons/react/24/outline";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import DirectoryAvatar from "../components/directory/DirectoryAvatar";
import DirectoryHelpOfferings, {
  DIRECTORY_OFFERING_LABELS,
} from "../components/directory/DirectoryHelpOfferings";
import { Button, Card, CardContent, PageHeader } from "../components/ui";
import { useToastReplacement } from "../contexts/NotificationModalContext";
import { useRuntimeConfig } from "../contexts/RuntimeConfigContext";
import {
  alumniDirectoryService,
  type DirectoryDetailDTO,
  type DirectoryHelpOfferingsDTO,
  type OwnAlumniProfileDTO,
} from "../services/api";
import { createIdempotencyKey } from "../utils/idempotencyKey";

interface AlumniProfileFormState {
  professionalHeadline: string;
  industry: string;
  skills: string;
  bio: string;
  helpOfferings: DirectoryHelpOfferingsDTO;
}

interface MutationKey {
  payload: string;
  key: string;
}

const REGISTRATION_PROFILE_FIELDS = new Set([
  "phone",
  "birthYear",
  "residenceCity",
  "residenceRegion",
  "residenceCountryCode",
  "employmentStatus",
  "company",
  "occupation",
]);

function formFrom(profile: OwnAlumniProfileDTO): AlumniProfileFormState {
  return {
    professionalHeadline: profile.professionalHeadline ?? "",
    industry: profile.industry ?? "",
    skills: profile.skills.join(", "),
    bio: profile.bio ?? "",
    helpOfferings: { ...profile.helpOfferings },
  };
}

function normalizedSkills(value: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value.split(/[,\n]/u)) {
    const skill = entry.trim().replace(/\s+/gu, " ");
    const key = skill.normalize("NFKC").toLocaleLowerCase();
    if (!skill || seen.has(key)) continue;
    seen.add(key);
    result.push(skill);
  }
  return result;
}

function nullable(value: string): string | null {
  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized || null;
}

function statusLabel(
  status: OwnAlumniProfileDTO["publishStatus"],
  hasCurrentPublicationConsent: boolean,
): string {
  if (status === "published" && hasCurrentPublicationConsent) return "Published";
  if (status === "published") return "Consent update required";
  if (status === "withdrawn") return "Withdrawn";
  return "Draft";
}

function statusClasses(
  status: OwnAlumniProfileDTO["publishStatus"],
  hasCurrentPublicationConsent: boolean,
): string {
  if (status === "published" && hasCurrentPublicationConsent) {
    return "bg-green-100 text-green-800";
  }
  if (status === "published") return "bg-amber-100 text-amber-800";
  if (status === "withdrawn") return "bg-gray-200 text-gray-700";
  return "bg-amber-100 text-amber-800";
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "status" in error &&
      (error as { status?: unknown }).status === 404,
  );
}

function ProfilePreview({ profile }: { profile: DirectoryDetailDTO }) {
  const professionalLine = [profile.occupation, profile.company]
    .filter(Boolean)
    .join(" · ");
  return (
    <Card>
      <CardContent>
        <article aria-label="Alumni profile preview" className="space-y-6">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
            <DirectoryAvatar
              avatar={profile.avatar}
              displayName={profile.displayName}
              size="detail"
            />
            <div className="min-w-0">
              <h2 className="break-words text-2xl font-semibold text-gray-900">
                {profile.displayName}
              </h2>
              {profile.professionalHeadline && (
                <p className="mt-1 break-words text-gray-700">
                  {profile.professionalHeadline}
                </p>
              )}
              {professionalLine && (
                <p className="mt-1 break-words text-sm text-gray-600">
                  {professionalLine}
                </p>
              )}
              {profile.generalLocation && (
                <p className="mt-2 text-sm text-gray-600">
                  {profile.generalLocation}
                </p>
              )}
            </div>
          </div>

          {profile.affiliations.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold text-gray-900">
                Verified alumni affiliations
              </h3>
              <ul className="mt-2 flex flex-wrap gap-2">
                {profile.affiliations.map((affiliation) => (
                  <li
                    className="rounded-full bg-blue-50 px-3 py-1 text-sm text-blue-800"
                    key={affiliation.id}
                  >
                    {[affiliation.programName, affiliation.cohortLabel]
                      .filter(Boolean)
                      .join(" ")}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <DirectoryHelpOfferings offerings={profile.helpOfferings} />
            <div className="space-y-4">
              {profile.industry && (
                <p className="text-sm text-gray-700">
                  <span className="font-semibold text-gray-900">Industry:</span>{" "}
                  {profile.industry}
                </p>
              )}
              {profile.skills.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">Skills</h3>
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {profile.skills.map((skill) => (
                      <li
                        className="rounded-full bg-gray-100 px-3 py-1 text-sm text-gray-700"
                        key={skill}
                      >
                        {skill}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
          {profile.bio && (
            <section>
              <h3 className="text-sm font-semibold text-gray-900">About</h3>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-gray-700">
                {profile.bio}
              </p>
            </section>
          )}
        </article>
      </CardContent>
    </Card>
  );
}

export default function MyAlumniProfile() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { config } = useRuntimeConfig();
  const notification = useToastReplacement();
  const [profile, setProfile] = useState<OwnAlumniProfileDTO | null>(null);
  const [preview, setPreview] = useState<DirectoryDetailDTO | null>(null);
  const [form, setForm] = useState<AlumniProfileFormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profileUnavailable, setProfileUnavailable] = useState(false);
  const [view, setView] = useState<"edit" | "preview">("preview");
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const previewModeButtonRef = useRef<HTMLButtonElement | null>(null);
  const withdrawButtonRef = useRef<HTMLButtonElement | null>(null);
  const keepPublishedButtonRef = useRef<HTMLButtonElement | null>(null);
  const publicationHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const mutationKeys = useRef(new Map<string, MutationKey>());
  const activeLoadController = useRef<AbortController | null>(null);
  const previewController = useRef<AbortController | null>(null);
  const previewSequence = useRef(0);
  const initialLoadStarted = useRef(false);
  // Older invitation links may still circulate. Drop their secret parameters
  // without attempting to claim a roster record or displaying the token.
  useEffect(() => {
    if (!searchParams.has("claim") && !searchParams.has("invitation")) return;
    const next = new URLSearchParams(searchParams);
    next.delete("claim");
    next.delete("invitation");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  const writable = config.alumniNetwork.writable;

  const keyFor = useCallback((operation: string, payload: unknown) => {
    const serialized = JSON.stringify(payload);
    const existing = mutationKeys.current.get(operation);
    if (existing?.payload === serialized) return existing.key;
    const key = createIdempotencyKey();
    mutationKeys.current.set(operation, { payload: serialized, key });
    return key;
  }, []);

  const acceptProfile = useCallback((next: OwnAlumniProfileDTO) => {
    previewController.current?.abort();
    previewController.current = null;
    previewSequence.current += 1;
    setProfile(next);
    setPreview(next);
    setForm(formFrom(next));
    setProfileUnavailable(false);
    setConsentAccepted(false);
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!signal?.aborted) {
      setLoading(true);
      setError(null);
      setProfileUnavailable(false);
    }
    try {
      let nextProfile: OwnAlumniProfileDTO;
      try {
        nextProfile = await alumniDirectoryService.getOwn(signal);
      } catch (getError) {
        if (!isNotFound(getError) || !writable) throw getError;
        try {
          nextProfile = await alumniDirectoryService.ensureOwnDraft(signal);
        } catch (createError) {
          if (
            isNotFound(createError) ||
            (createError &&
              typeof createError === "object" &&
              "status" in createError &&
              [409, 422].includes(
                Number((createError as { status?: unknown }).status),
              ))
          ) {
            setProfileUnavailable(true);
            return;
          }
          throw createError;
        }
      }
      if (!signal?.aborted) acceptProfile(nextProfile);
    } catch (loadError) {
      if (signal?.aborted) {
        return;
      }
      if (isNotFound(loadError)) {
        setProfileUnavailable(true);
      } else if (
        !(loadError instanceof DOMException && loadError.name === "AbortError")
      ) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Unable to load your alumni profile.",
        );
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, [acceptProfile, writable]);

  useEffect(() => {
    if (initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    const controller = new AbortController();
    let settled = false;
    activeLoadController.current?.abort();
    activeLoadController.current = controller;
    void load(controller.signal).finally(() => {
      if (!controller.signal.aborted) {
        settled = true;
      }
      if (activeLoadController.current === controller) {
        activeLoadController.current = null;
      }
    });
    return () => {
      controller.abort();
      activeLoadController.current?.abort();
      previewController.current?.abort();
      if (!settled) {
        initialLoadStarted.current = false;
      }
    };
  }, [load]);

  const retryLoad = useCallback(() => {
    activeLoadController.current?.abort();
    const controller = new AbortController();
    activeLoadController.current = controller;
    void load(controller.signal).finally(() => {
      if (activeLoadController.current === controller) {
        activeLoadController.current = null;
      }
    });
  }, [load]);

  const normalizedForm = useMemo(() => {
    if (!form) return null;
    return {
      professionalHeadline: nullable(form.professionalHeadline),
      industry: nullable(form.industry),
      skills: normalizedSkills(form.skills),
      bio: nullable(form.bio),
      helpOfferings: form.helpOfferings,
    };
  }, [form]);

  const dirty = useMemo(() => {
    if (!profile || !normalizedForm) return false;
    return (
      JSON.stringify(normalizedForm) !==
      JSON.stringify({
        professionalHeadline: profile.professionalHeadline,
        industry: profile.industry,
        skills: profile.skills,
        bio: profile.bio,
        helpOfferings: profile.helpOfferings,
      })
    );
  }, [normalizedForm, profile]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!profile || !normalizedForm || !writable) return;
    if (normalizedForm.skills.length > 20) {
      notification.error("Add no more than 20 skills.");
      return;
    }
    const payload = { expectedRevision: profile.revision, ...normalizedForm };
    setSaving(true);
    try {
      const next = await alumniDirectoryService.updateOwn(
        payload,
        keyFor("update", payload),
      );
      mutationKeys.current.delete("update");
      acceptProfile(next);
      setView("preview");
      window.setTimeout(() => previewModeButtonRef.current?.focus(), 0);
      notification.success("Your alumni profile has been saved.");
    } catch (saveError) {
      notification.error(
        saveError instanceof Error ? saveError.message : "Unable to save profile.",
      );
    } finally {
      setSaving(false);
    }
  };

  const showPreview = async () => {
    if (!profile) return;
    previewController.current?.abort();
    const controller = new AbortController();
    previewController.current = controller;
    const sequence = ++previewSequence.current;
    setView("preview");
    try {
      const nextPreview = await alumniDirectoryService.previewOwn(
        controller.signal,
      );
      if (!controller.signal.aborted && sequence === previewSequence.current) {
        setPreview(nextPreview);
      }
    } catch (previewError) {
      if (!controller.signal.aborted && sequence === previewSequence.current) {
        notification.error(
          previewError instanceof Error
            ? previewError.message
            : "Unable to load preview.",
        );
      }
    } finally {
      if (sequence === previewSequence.current) {
        previewController.current = null;
      }
    }
  };

  const publish = async () => {
    if (!profile || !writable || !consentAccepted || dirty) return;
    const payload = {
      expectedRevision: profile.revision,
      consentVersion: profile.publicationConsent.version,
      consentAccepted: true as const,
    };
    setSaving(true);
    try {
      const next = await alumniDirectoryService.publishOwn(
        payload,
        keyFor("publish", payload),
      );
      mutationKeys.current.delete("publish");
      acceptProfile(next);
      notification.success("Your alumni profile is now published.");
    } catch (publishError) {
      notification.error(
        publishError instanceof Error
          ? publishError.message
          : "Unable to publish profile.",
      );
    } finally {
      setSaving(false);
    }
  };

  const withdraw = async () => {
    if (!profile || !writable) return;
    const payload = { expectedRevision: profile.revision };
    setSaving(true);
    try {
      const next = await alumniDirectoryService.withdrawOwn(
        profile.revision,
        keyFor("withdraw", payload),
      );
      mutationKeys.current.delete("withdraw");
      acceptProfile(next);
      setConfirmWithdraw(false);
      window.setTimeout(() => publicationHeadingRef.current?.focus(), 0);
      notification.success("Your alumni profile has been withdrawn.");
    } catch (withdrawError) {
      notification.error(
        withdrawError instanceof Error
          ? withdrawError.message
          : "Unable to withdraw profile.",
      );
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div aria-live="polite" className="py-16 text-center text-gray-600">
        <ArrowPathIcon className="mx-auto h-7 w-7 animate-spin" />
        <p className="mt-3">Loading your alumni profile…</p>
      </div>
    );
  }
  if (profileUnavailable) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="My Alumni Profile" />
        <Card>
          <CardContent>
            <h2 className="text-lg font-semibold text-gray-900">
              Alumni profile not available
            </h2>
            <p className="mt-2 text-sm leading-6 text-gray-600">
              {!writable
                ? "Alumni Profile updates are temporarily paused. Please try again when editing is available."
                : "Complete your ERP account information to create your private Alumni Profile. If your account information is already complete, try again."}
            </p>
            {writable && (
              <div className="mt-4 flex flex-wrap gap-3">
                <Link
                  className="inline-flex min-h-10 items-center rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800"
                  to="/dashboard/profile?mode=complete"
                >
                  Complete account profile
                </Link>
                <Button onClick={retryLoad} variant="outline">
                  Try Again
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }
  if (error || !profile || !form) {
    return (
      <div className="mx-auto max-w-2xl rounded-lg border border-red-200 bg-red-50 p-5 text-red-800">
        <p>{error ?? "Unable to load your alumni profile."}</p>
        <Button className="mt-4" onClick={retryLoad} variant="outline">
          Try Again
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="My Alumni Profile"
        subtitle="Choose what active, verified @Cloud members can see in the Alumni Directory."
      />

      <div className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <span
            className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusClasses(profile.publishStatus, profile.hasCurrentPublicationConsent)}`}
          >
            {statusLabel(
              profile.publishStatus,
              profile.hasCurrentPublicationConsent,
            )}
          </span>
          {profile.updatedAt && (
            <p className="mt-2 text-xs text-gray-500">
              Last saved {new Date(profile.updatedAt).toLocaleString()}
            </p>
          )}
        </div>
        <div
          aria-label="Alumni profile view"
          className="grid grid-cols-2 gap-2"
          role="group"
        >
          <Button
            aria-pressed={view === "preview"}
            leftIcon={<EyeIcon className="h-4 w-4" />}
            onClick={() => void showPreview()}
            ref={previewModeButtonRef}
            type="button"
            variant={view === "preview" ? "primary" : "outline"}
          >
            Preview
          </Button>
          <Button
            aria-pressed={view === "edit"}
            leftIcon={<PencilSquareIcon className="h-4 w-4" />}
            onClick={() => setView("edit")}
            type="button"
            variant={view === "edit" ? "primary" : "outline"}
          >
            Edit
          </Button>
        </div>
      </div>

      {!writable && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Alumni Network is currently read-only. You can view your saved profile,
          but changes and publication actions are paused.
        </div>
      )}

      {view === "preview" ? (
        <>
          {dirty && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">
              This preview shows the last saved version. Save your edits before publishing.
            </div>
          )}
          <ProfilePreview profile={preview ?? profile} />
        </>
      ) : (
        <Card>
          <CardContent>
            <form className="space-y-6" noValidate onSubmit={save}>
              <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                <label className="block">
                  <span className="text-sm font-medium text-gray-700">
                    Professional headline
                  </span>
                  <input
                    className="mt-1 min-h-11 w-full rounded-md border border-gray-500 px-3 py-2 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    disabled={!writable || saving}
                    maxLength={160}
                    onChange={(event) =>
                      setForm((current) =>
                        current
                          ? { ...current, professionalHeadline: event.target.value }
                          : current,
                      )
                    }
                    placeholder="How you describe your professional work"
                    value={form.professionalHeadline}
                  />
                </label>
                <label className="block">
                  <span className="text-sm font-medium text-gray-700">Industry</span>
                  <input
                    className="mt-1 min-h-11 w-full rounded-md border border-gray-500 px-3 py-2 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    disabled={!writable || saving}
                    maxLength={100}
                    onChange={(event) =>
                      setForm((current) =>
                        current ? { ...current, industry: event.target.value } : current,
                      )
                    }
                    placeholder="e.g. Technology"
                    value={form.industry}
                  />
                </label>
              </div>

              <label className="block">
                <span className="text-sm font-medium text-gray-700">Skills</span>
                <input
                  className="mt-1 min-h-11 w-full rounded-md border border-gray-500 px-3 py-2 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  disabled={!writable || saving}
                  maxLength={1_600}
                  onChange={(event) =>
                    setForm((current) =>
                      current ? { ...current, skills: event.target.value } : current,
                    )
                  }
                  placeholder="Separate up to 20 skills with commas"
                  value={form.skills}
                />
                <p className="mt-1 text-xs text-gray-500">
                  {normalizedSkills(form.skills).length}/20 skills
                </p>
              </label>

              <label className="block">
                <span className="text-sm font-medium text-gray-700">About</span>
                <textarea
                  className="mt-1 w-full rounded-md border border-gray-500 px-3 py-2 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  disabled={!writable || saving}
                  maxLength={2_000}
                  onChange={(event) =>
                    setForm((current) =>
                      current ? { ...current, bio: event.target.value } : current,
                    )
                  }
                  placeholder="Share the experience and perspective you would like alumni to know."
                  rows={6}
                  value={form.bio}
                />
                <p className="mt-1 text-right text-xs text-gray-500">
                  {Array.from(form.bio).length}/2000
                </p>
              </label>

              <fieldset>
                <legend className="text-sm font-semibold text-gray-900">
                  Help offerings
                </legend>
                <p className="mt-1 text-sm text-gray-600">
                  Turn each type on or off independently. Details will be decided
                  naturally in the private conversation.
                </p>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {DIRECTORY_OFFERING_LABELS.map(({ key, label }) => (
                    <label
                      className="flex min-h-11 items-center gap-3 rounded-md border border-gray-200 p-3"
                      key={key}
                    >
                      <input
                        checked={form.helpOfferings[key]}
                        className="h-4 w-4 rounded border-gray-500 text-blue-600 focus:ring-blue-600"
                        disabled={!writable || saving}
                        onChange={(event) =>
                          setForm((current) =>
                            current
                              ? {
                                  ...current,
                                  helpOfferings: {
                                    ...current.helpOfferings,
                                    [key]: event.target.checked,
                                  },
                                }
                              : current,
                          )
                        }
                        type="checkbox"
                      />
                      <span className="text-sm text-gray-800">{label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="flex flex-col-reverse gap-2 border-t border-gray-200 pt-5 sm:flex-row sm:justify-end">
                <Button
                  disabled={saving}
                  onClick={() => {
                    setForm(formFrom(profile));
                    setView("preview");
                    window.setTimeout(
                      () => previewModeButtonRef.current?.focus(),
                      0,
                    );
                  }}
                  type="button"
                  variant="secondary"
                >
                  Cancel
                </Button>
                <Button
                  disabled={!dirty || !writable}
                  loading={saving}
                  type="submit"
                >
                  Save Profile
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent>
          <section aria-labelledby="publication-heading" className="space-y-4">
            <div>
              <h2
                className="text-lg font-semibold text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                id="publication-heading"
                ref={publicationHeadingRef}
                tabIndex={-1}
              >
                Directory publication
              </h2>
              <p className="mt-1 text-sm text-gray-600">
                Your exact phone number, email address, and birth year are never included
                in the Alumni Directory. Review{" "}
                <Link className="font-medium text-blue-700 underline" to="/privacy">
                  Privacy &amp; Data Use
                </Link>
                .
              </p>
            </div>

            {profile.acceptedPublicationConsent && (
              <details className="rounded-md border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700">
                <summary className="cursor-pointer font-medium text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                  View accepted publication consent record
                </summary>
                <p className="mt-3 leading-6">
                  {profile.acceptedPublicationConsent.text}
                </p>
                <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="font-medium text-gray-700">Version</dt>
                    <dd>{profile.acceptedPublicationConsent.version}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-gray-700">Accepted</dt>
                    <dd>
                      {new Date(
                        profile.acceptedPublicationConsent.acceptedAt,
                      ).toLocaleString()}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-medium text-gray-700">Effective</dt>
                    <dd>
                      {new Date(
                        profile.acceptedPublicationConsent.effectiveAt,
                      ).toLocaleString()}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="font-medium text-gray-700">Document hash</dt>
                    <dd className="break-all font-mono">
                      {profile.acceptedPublicationConsent.documentHash}
                    </dd>
                  </div>
                </dl>
              </details>
            )}

            {!profile.publishReadiness.ready && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-4">
                <h3 className="text-sm font-semibold text-amber-900">
                  Complete these items before publishing
                </h3>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900">
                  {profile.publishReadiness.issues.map((issue) => (
                    <li key={`${issue.field}:${issue.code}`}>{issue.message}</li>
                  ))}
                </ul>
                {profile.publishReadiness.issues.some((issue) =>
                  REGISTRATION_PROFILE_FIELDS.has(issue.field),
                ) && (
                  <Link
                    className="mt-3 inline-flex text-sm font-medium text-blue-700 hover:underline"
                    to="/dashboard/profile?mode=complete"
                  >
                    Complete My ERP Profile
                  </Link>
                )}
              </div>
            )}

            {!profile.hasCurrentPublicationConsent ? (
              <>
                {profile.publishStatus === "published" && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                    Your earlier publication consent is no longer current. Your
                    profile is hidden from the Directory until you accept the
                    current consent and republish it.
                  </div>
                )}
                <label className="flex items-start gap-3 rounded-md border border-gray-200 p-4">
                  <input
                    checked={consentAccepted}
                    className="mt-1 h-4 w-4 rounded border-gray-500 text-blue-600 focus:ring-blue-600"
                    disabled={!writable || saving}
                    onChange={(event) => setConsentAccepted(event.target.checked)}
                    type="checkbox"
                  />
                  <span className="text-sm leading-6 text-gray-700">
                    {profile.publicationConsent.text}
                    <span className="mt-1 block text-xs text-gray-500">
                      Consent version: {profile.publicationConsent.version}
                    </span>
                  </span>
                </label>
                <Button
                  disabled={
                    !writable ||
                    saving ||
                    dirty ||
                    !consentAccepted ||
                    !profile.publishReadiness.ready
                  }
                  leftIcon={<CheckCircleIcon className="h-5 w-5" />}
                  loading={saving}
                  onClick={() => void publish()}
                  type="button"
                  variant="success"
                >
                  {profile.publishStatus === "published"
                    ? "Accept and Republish Profile"
                    : "Publish Profile"}
                </Button>
              </>
            ) : confirmWithdraw ? (
              <div className="rounded-md border border-red-200 bg-red-50 p-4">
                <p className="text-sm text-red-900">
                  Withdraw this profile from the Directory now? You can edit and
                  publish it again later with new consent.
                </p>
                <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row">
                  <Button
                    disabled={saving}
                    onClick={() => {
                      setConfirmWithdraw(false);
                      window.setTimeout(
                        () => withdrawButtonRef.current?.focus(),
                        0,
                      );
                    }}
                    ref={keepPublishedButtonRef}
                    type="button"
                    variant="secondary"
                  >
                    Keep Published
                  </Button>
                  <Button
                    loading={saving}
                    onClick={() => void withdraw()}
                    type="button"
                    variant="danger"
                  >
                    Confirm Withdrawal
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                disabled={!writable || saving}
                onClick={() => {
                  setConfirmWithdraw(true);
                  window.setTimeout(
                    () => keepPublishedButtonRef.current?.focus(),
                    0,
                  );
                }}
                ref={withdrawButtonRef}
                type="button"
                variant="danger"
              >
                Withdraw Profile
              </Button>
            )}
          </section>
        </CardContent>
      </Card>
    </div>
  );
}

export { ProfilePreview, formFrom, normalizedSkills };
