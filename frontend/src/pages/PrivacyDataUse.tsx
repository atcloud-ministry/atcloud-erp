import { Link } from "react-router-dom";

const retentionRows = [
  [
    "Directory publication consent record",
    "12 months after it is superseded or withdrawn, or after account deletion",
  ],
  [
    "Help request never accepted",
    "2 months after decline or withdrawal",
  ],
  [
    "Accepted Help request, outcome revisions, and timeline",
    "The later of 12 months after closure or 30 days after the 20-day outcome-confirmation due time",
  ],
  ["Chat message", "Rolling 12 months from message creation"],
  [
    "Conversation, membership, and access windows",
    "The later of 24 months after room archive or 30 days after the last message is purged",
  ],
  [
    "Push subscription",
    "Deleted immediately after unsubscribe or permanent endpoint failure, or after 90 days without successful use",
  ],
  [
    "Notification outbox",
    "30 days after delivery; 90 days after dead status; pending and processing records remain until terminal",
  ],
  ["Audit log", "3 months"],
] as const;

export default function PrivacyDataUse() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
      <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-gray-200 sm:p-8">
        <h1 className="text-3xl font-bold text-gray-900">Privacy &amp; Data Use</h1>
        <p className="mt-3 text-sm text-gray-600">
          Effective September 18, 2026
        </p>

        <div className="mt-8 space-y-8 text-sm leading-6 text-gray-700">
          <section aria-labelledby="account-data-heading">
            <h2
              className="text-xl font-semibold text-gray-900"
              id="account-data-heading"
            >
              Account and profile data
            </h2>
            <p className="mt-2">
              @Cloud uses registration and profile information to create and
              secure accounts, operate programs and community features, deliver
              service communications, and produce privacy-protected aggregate
              reporting. Access to account profiles follows authenticated role
              permissions.
            </p>
          </section>

          <section aria-labelledby="directory-data-heading">
            <h2
              className="text-xl font-semibold text-gray-900"
              id="directory-data-heading"
            >
              Alumni Directory
            </h2>
            <p className="mt-2">
              A Directory profile is shown only after separate publication
              consent and only to active, verified @Cloud ERP members. It can
              include a chosen name, avatar, professional details, general
              location, verified program affiliations, skills, biography, and
              help offerings. While the profile remains published, later
              changes saved to those public fields also appear in the
              Directory. Email address, phone number, and exact birth year are
              not shown in the Directory. Withdrawing consent hides the profile
              immediately. A withdrawn profile remains a private draft while the account
              exists. When account deletion is approved, User profile/KPI data,
              Alumni Profile, and Alumni Affiliation records stop appearing
              immediately and are removed from the primary database within 30
              days.
            </p>
          </section>

          <section aria-labelledby="help-data-heading">
            <h2
              className="text-xl font-semibold text-gray-900"
              id="help-data-heading"
            >
              Alumni Help
            </h2>
            <p className="mt-2">
              A Help request and its private room are available only to the
              requester and selected alumni helper. The selected help type,
              opening note, participant identity, messages, workflow history,
              and confirmed outcome support the request and its related
              notifications. Each request stores the exact consent and
              disclaimer version accepted when it was sent.
            </p>
          </section>

          <section aria-labelledby="chat-data-heading">
            <h2
              className="text-xl font-semibold text-gray-900"
              id="chat-data-heading"
            >
              Chat rooms and notifications
            </h2>
            <p className="mt-2">
              Program Rooms are available to current eligible Program members.
              Muting a room stops its optional notifications but keeps room
              access. Unenrolling ends access to new messages and updates while
              preserving the member&apos;s permitted history view. Notification
              settings control optional push and email delivery; essential
              account and workflow communications may still be delivered.
            </p>
          </section>

          <section aria-labelledby="retention-heading">
            <h2
              className="text-xl font-semibold text-gray-900"
              id="retention-heading"
            >
              Retention periods
            </h2>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-gray-300">
                    <th className="px-3 py-2 font-semibold text-gray-900" scope="col">
                      Record
                    </th>
                    <th className="px-3 py-2 font-semibold text-gray-900" scope="col">
                      Retention
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {retentionRows.map(([record, retention]) => (
                    <tr className="border-b border-gray-200" key={record}>
                      <th className="px-3 py-3 align-top font-medium text-gray-900" scope="row">
                        {record}
                      </th>
                      <td className="px-3 py-3 align-top">{retention}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="choices-heading">
            <h2
              className="text-xl font-semibold text-gray-900"
              id="choices-heading"
            >
              Your choices
            </h2>
            <p className="mt-2">
              You can edit your account information, change notification
              settings, withdraw Directory publication, and mute Program Rooms
              from the corresponding feature pages. A new consent version must
              be reviewed before a hidden Directory profile can be republished.
            </p>
          </section>
        </div>

        <nav aria-label="Privacy page links" className="mt-8 border-t border-gray-200 pt-5">
          <Link
            className="inline-flex min-h-11 items-center rounded-md px-3 py-2 font-medium text-blue-700 hover:bg-blue-50 hover:text-blue-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            to="/"
          >
            Return to @Cloud
          </Link>
        </nav>
      </div>
    </main>
  );
}
