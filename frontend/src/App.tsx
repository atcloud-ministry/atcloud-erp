import { lazy, Suspense } from "react";
import {
  Routes,
  Route,
  Navigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext";
import { NotificationProvider } from "./contexts/NotificationContext";
import { NotificationProvider as NotificationModalProvider } from "./contexts/NotificationModalContext";
import { RuntimeConfigProvider } from "./contexts/RuntimeConfigContext";
import ProtectedRoute from "./components/common/ProtectedRoute";
import SessionExpiredModal from "./components/common/SessionExpiredModal";
import LoadingSpinner from "./components/common/LoadingSpinner";

const Home = lazy(() => import("./pages/Home"));
const SignUp = lazy(() => import("./pages/SignUp"));
const Login = lazy(() => import("./pages/Login"));
const CheckEmail = lazy(() => import("./pages/CheckEmail"));
const EmailVerification = lazy(() => import("./pages/EmailVerification"));
const Welcome = lazy(() => import("./pages/Welcome"));
const UpcomingEvents = lazy(() => import("./pages/UpcomingEvents"));
const PassedEvents = lazy(() => import("./pages/PassedEvents"));
const MyEvents = lazy(() => import("./pages/MyEvents"));
const PublishedEvents = lazy(() => import("./pages/PublishedEvents"));
const Programs = lazy(() => import("./pages/Programs"));
const EMBAProgram = lazy(() => import("./pages/EMBAProgram"));
const ProgramDetail = lazy(() => import("./pages/ProgramDetail"));
const EnrollProgram = lazy(() => import("./pages/EnrollProgram"));
const PurchaseSuccess = lazy(() => import("./pages/PurchaseSuccess"));
const PurchaseCancel = lazy(() => import("./pages/PurchaseCancel"));
const PurchaseHistory = lazy(() => import("./pages/PurchaseHistory"));
const PurchaseReceipt = lazy(() => import("./pages/PurchaseReceipt"));
const AnnualMemberships = lazy(() => import("./pages/AnnualMemberships"));
const AnnualMembershipDetail = lazy(
  () => import("./pages/AnnualMembershipDetail"),
);
const AnnualMembershipForm = lazy(
  () => import("./pages/AnnualMembershipForm"),
);
const IncomeHistory = lazy(() => import("./pages/IncomeHistory"));
const CreateNewProgram = lazy(() => import("./pages/CreateNewProgram"));
const EditProgram = lazy(() => import("./pages/EditProgram"));
const CreateEvent = lazy(() => import("./pages/CreateEvent"));
const Management = lazy(() => import("./pages/Management"));
const Profile = lazy(() => import("./pages/Profile"));
const UserProfile = lazy(() => import("./pages/UserProfile"));
const RequestPasswordChange = lazy(
  () => import("./pages/RequestPasswordChange"),
);
const CompletePasswordChange = lazy(
  () => import("./pages/CompletePasswordChange"),
);
const ResetPassword = lazy(() => import("./pages/ResetPassword"));
const SystemMessages = lazy(() => import("./pages/SystemMessages"));
const Analytics = lazy(() => import("./pages/Analytics"));
const SystemMonitor = lazy(() => import("./pages/SystemMonitor"));
const EditEvent = lazy(() => import("./pages/EditEvent"));
const Feedback = lazy(() => import("./pages/Feedback"));
const AuditLogs = lazy(() => import("./pages/AuditLogs"));
const DashboardLayout = lazy(() => import("./layouts/DashboardLayout"));
const EventDetailAccessRoute = lazy(
  () => import("./components/EventDetail/EventDetailAccessRoute"),
);
const GetInvolved = lazy(() => import("./pages/GetInvolved"));
const GuestRegistration = lazy(() => import("./pages/GuestRegistration"));
const GuestConfirmation = lazy(() => import("./pages/GuestConfirmation"));
const GuestManage = lazy(() => import("./pages/GuestManage"));
const AssignmentRejection = lazy(() => import("./pages/AssignmentRejection"));
const GuestDecline = lazy(() => import("./pages/GuestDecline"));
const PublicEvent = lazy(() => import("./pages/PublicEvent"));
const PublicEventsList = lazy(() => import("./pages/PublicEventsList"));
const ShortLinkRedirect = lazy(() => import("./pages/ShortLinkRedirect"));
const ConfigureRolesTemplates = lazy(
  () => import("./pages/ConfigureRolesTemplates"),
);
const CreateRolesTemplate = lazy(() => import("./pages/CreateRolesTemplate"));
const EditRolesTemplate = lazy(() => import("./pages/EditRolesTemplate"));
const ViewRolesTemplate = lazy(() => import("./pages/ViewRolesTemplate"));
const MyPromoCodes = lazy(() => import("./pages/MyPromoCodes"));
const AdminPromoCodes = lazy(() => import("./pages/AdminPromoCodes"));
const PromoCodeDetail = lazy(() => import("./pages/PromoCodeDetail"));
const DonationPage = lazy(() => import("./pages/DonationPage"));
const DonationReceipt = lazy(() => import("./pages/DonationReceipt"));
const RefundRequestApproval = lazy(
  () => import("./pages/RefundRequestApproval"),
);
const RefundRequestDecision = lazy(
  () => import("./pages/RefundRequestDecision"),
);
const EventPurchase = lazy(() => import("./pages/EventPurchase"));
const EventPurchaseSuccess = lazy(
  () => import("./pages/EventPurchaseSuccess"),
);

/** Redirect legacy /pr/:id to /dashboard/programs/:id */
function PrRedirect() {
  const { id } = useParams();
  return <Navigate to={`/dashboard/programs/${id}`} replace />;
}

function RootRoute() {
  const [searchParams] = useSearchParams();
  const verificationToken = searchParams.get("verifyEmailToken");

  if (verificationToken) {
    return <EmailVerification tokenOverride={verificationToken} />;
  }

  return <Home />;
}

function App() {
  return (
    <RuntimeConfigProvider>
      <AuthProvider>
        <NotificationModalProvider>
          <NotificationProvider>
            <SessionExpiredModal />
            <Suspense fallback={<LoadingSpinner size="lg" />}>
              <Routes>
            <Route path="/" element={<RootRoute />} />
            <Route path="/signup" element={<SignUp />} />
            <Route path="/login" element={<Login />} />
            {/* Public guest routes (migrated to root) */}
            <Route path="/guest-register/:id" element={<GuestRegistration />} />
            <Route path="/guest-confirmation" element={<GuestConfirmation />} />
            <Route path="/guest-manage/:token" element={<GuestManage />} />
            {/* Public role assignment rejection route */}
            <Route
              path="/assignments/reject"
              element={<AssignmentRejection />}
            />
            {/* Guest invitation decline route */}
            <Route path="/guest/decline/:token" element={<GuestDecline />} />
            {/* Guest dashboard routes removed (legacy self-registration UI deprecated) */}
            <Route path="/check-email" element={<CheckEmail />} />
            <Route
              path="/verify-email/:token"
              element={<EmailVerification />}
            />
            <Route path="/reset-password/:token" element={<ResetPassword />} />
            <Route
              path="/change-password/confirm/:token"
              element={<CompletePasswordChange />}
            />
            <Route path="/dashboard" element={<DashboardLayout />}>
              <Route index element={<EMBAProgram />} />
              <Route path="welcome" element={<Welcome />} />
              <Route path="upcoming" element={<UpcomingEvents />} />
              <Route path="passed" element={<PassedEvents />} />
              <Route path="my-events" element={<MyEvents />} />
              <Route
                path="published-events"
                element={
                  <ProtectedRoute
                    allowedRoles={["Super Admin", "Administrator", "Leader"]}
                  >
                    <PublishedEvents />
                  </ProtectedRoute>
                }
              />
              <Route path="emba-program" element={<EMBAProgram />} />
              <Route path="programs" element={<Programs />} />
              <Route path="programs/:id" element={<ProgramDetail />} />
              <Route path="programs/:id/enroll" element={<EnrollProgram />} />
              <Route
                path="annual-memberships"
                element={<AnnualMemberships />}
              />
              <Route
                path="annual-memberships/new"
                element={
                  <ProtectedRoute
                    allowedRoles={["Super Admin", "Administrator"]}
                  >
                    <AnnualMembershipForm />
                  </ProtectedRoute>
                }
              />
              <Route
                path="annual-memberships/:id"
                element={<AnnualMembershipDetail />}
              />
              <Route
                path="annual-memberships/:id/edit"
                element={
                  <ProtectedRoute
                    allowedRoles={["Super Admin", "Administrator"]}
                  >
                    <AnnualMembershipForm />
                  </ProtectedRoute>
                }
              />
              <Route path="purchase-history" element={<PurchaseHistory />} />
              <Route
                path="purchase-receipt/:id"
                element={<PurchaseReceipt />}
              />
              <Route
                path="purchases/:id/receipt"
                element={<PurchaseReceipt />}
              />
              <Route
                path="income-history"
                element={
                  <ProtectedRoute
                    allowedRoles={["Super Admin", "Administrator"]}
                  >
                    <IncomeHistory />
                  </ProtectedRoute>
                }
              />
              <Route path="purchase/success" element={<PurchaseSuccess />} />
              <Route path="purchase/cancel" element={<PurchaseCancel />} />
              <Route
                path="refund-requests/:id/approval"
                element={
                  <ProtectedRoute
                    allowedRoles={["Super Admin", "Administrator"]}
                  >
                    <RefundRequestApproval />
                  </ProtectedRoute>
                }
              />
              <Route
                path="refund-requests/:id/decision"
                element={<RefundRequestDecision />}
              />
              <Route
                path="programs/:id/edit"
                element={
                  <ProtectedRoute
                    allowedRoles={[
                      "Super Admin",
                      "Administrator",
                      "Leader",
                      "Participant",
                      "Guest Expert",
                    ]}
                  >
                    <EditProgram />
                  </ProtectedRoute>
                }
              />
              <Route
                path="programs/new"
                element={
                  <ProtectedRoute
                    allowedRoles={["Super Admin", "Administrator", "Leader"]}
                  >
                    <CreateNewProgram />
                  </ProtectedRoute>
                }
              />
              <Route
                path="new-event"
                element={
                  <ProtectedRoute
                    allowedRoles={[
                      "Super Admin",
                      "Administrator",
                      "Leader",
                      "Participant",
                      "Guest Expert",
                    ]}
                  >
                    <CreateEvent />
                  </ProtectedRoute>
                }
              />
              <Route
                path="management"
                element={
                  <ProtectedRoute
                    allowedRoles={[
                      "Super Admin",
                      "Administrator",
                      "Leader",
                      "Participant",
                      "Guest Expert",
                    ]}
                  >
                    <Management />
                  </ProtectedRoute>
                }
              />
              <Route path="profile" element={<Profile />} />
              <Route path="profile/:userId" element={<UserProfile />} />
              <Route
                path="change-password"
                element={<RequestPasswordChange />}
              />
              <Route path="system-messages" element={<SystemMessages />} />
              <Route path="get-involved" element={<GetInvolved />} />
              <Route
                path="edit-event/:id"
                element={
                  <ProtectedRoute
                    allowedRoles={[
                      "Super Admin",
                      "Administrator",
                      "Leader",
                      "Participant",
                      "Guest Expert",
                    ]}
                  >
                    <EditEvent />
                  </ProtectedRoute>
                }
              />
              <Route
                path="analytics"
                element={
                  // Allow all authenticated roles; page handles restricted view for Participants
                  <ProtectedRoute
                    allowedRoles={[
                      "Super Admin",
                      "Administrator",
                      "Leader",
                      "Participant",
                      "Guest Expert",
                    ]}
                  >
                    <Analytics />
                  </ProtectedRoute>
                }
              />
              <Route
                path="monitor"
                element={
                  <ProtectedRoute allowedRoles={["Super Admin"]}>
                    <SystemMonitor />
                  </ProtectedRoute>
                }
              />
              <Route
                path="audit-logs"
                element={
                  <ProtectedRoute
                    allowedRoles={["Super Admin", "Administrator"]}
                  >
                    <AuditLogs />
                  </ProtectedRoute>
                }
              />
              <Route path="feedback" element={<Feedback />} />
              {/* Donation Page - Available to all authenticated users */}
              <Route path="donate" element={<DonationPage />} />
              {/* Donation Receipt - Available to all authenticated users */}
              <Route path="donation-receipt" element={<DonationReceipt />} />
              {/* User: My Promo Codes - Available to all authenticated users */}
              <Route path="promo-codes" element={<MyPromoCodes />} />
              {/* Admin: Promo Codes Management - Super Admin & Administrator only */}
              <Route
                path="admin/promo-codes"
                element={
                  <ProtectedRoute
                    allowedRoles={["Super Admin", "Administrator"]}
                  >
                    <AdminPromoCodes />
                  </ProtectedRoute>
                }
              />
              {/* Admin: Promo Code Detail - Super Admin & Administrator only */}
              <Route
                path="admin/promo-codes/:id"
                element={
                  <ProtectedRoute
                    allowedRoles={["Super Admin", "Administrator"]}
                  >
                    <PromoCodeDetail />
                  </ProtectedRoute>
                }
              />
              <Route
                path="configure-roles-templates"
                element={
                  <ProtectedRoute
                    allowedRoles={["Super Admin", "Administrator", "Leader"]}
                  >
                    <ConfigureRolesTemplates />
                  </ProtectedRoute>
                }
              />
              <Route
                path="create-roles-template"
                element={
                  <ProtectedRoute
                    allowedRoles={["Super Admin", "Administrator", "Leader"]}
                  >
                    <CreateRolesTemplate />
                  </ProtectedRoute>
                }
              />
              <Route
                path="edit-roles-template/:id"
                element={
                  <ProtectedRoute
                    allowedRoles={["Super Admin", "Administrator", "Leader"]}
                  >
                    <EditRolesTemplate />
                  </ProtectedRoute>
                }
              />
              <Route
                path="view-roles-template/:id"
                element={
                  <ProtectedRoute
                    allowedRoles={["Super Admin", "Administrator", "Leader"]}
                  >
                    <ViewRolesTemplate />
                  </ProtectedRoute>
                }
              />
            </Route>
            {/* Paid Events Purchase Flow (Phase 6) */}
            <Route
              path="/dashboard/events/:id/purchase"
              element={
                <ProtectedRoute>
                  <EventPurchase />
                </ProtectedRoute>
              }
            />
            <Route
              path="/dashboard/events/:id/purchase/success"
              element={
                <ProtectedRoute>
                  <EventPurchaseSuccess />
                </ProtectedRoute>
              }
            />
            {/* Event Detail Page */}
            <Route
              path="/dashboard/event/:id"
              element={<EventDetailAccessRoute />}
            />
            <Route path="/logout" element={<Home />} />
            {/* Public events list page (unauthenticated) */}
            <Route path="/events" element={<PublicEventsList />} />
            {/* Public published event page (unauthenticated) */}
            <Route path="/p/:slug" element={<PublicEvent />} />
            {/* Legacy /pr/:id → redirect to dashboard programs */}
            <Route path="/pr/:id" element={<PrRedirect />} />
            {/* SPA fallback for short link resolution (dev / proxy safety) */}
            <Route path="/s/:key" element={<ShortLinkRedirect />} />
              </Routes>
            </Suspense>
          </NotificationProvider>
        </NotificationModalProvider>
      </AuthProvider>
    </RuntimeConfigProvider>
  );
}

export default App;
