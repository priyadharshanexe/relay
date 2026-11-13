import { Navigate, Route, Routes, useSearchParams } from "react-router-dom";
import { AuthProvider, useSessionQuery } from "./auth/AuthProvider";
import { Layout } from "./components/Layout";
import { ErrorState, LoadingState } from "./components/ui";
import { ApiKeysPage } from "./pages/ApiKeysPage";
import { LoginPage, RegisterPage } from "./pages/AuthPages";
import { DeadLetterPage, DeliveriesPage } from "./pages/DeliveriesPage";
import { DeliveryDetailPage } from "./pages/DeliveryDetailPage";
import { EndpointsPage } from "./pages/EndpointsPage";
import { InvitePage } from "./pages/InvitePage";
import { LivePage } from "./pages/LivePage";
import { ReceiversPage } from "./pages/ReceiversPage";
import { TeamPage } from "./pages/TeamPage";

/** Where someone lands right after logging in: back on the invitation they came
 *  to accept, or on the dashboard. */
function AfterLogin() {
  const [params] = useSearchParams();
  const invite = params.get("invite");
  return <Navigate to={invite ? `/invite/${encodeURIComponent(invite)}` : "/endpoints"} replace />;
}

export function App() {
  const session = useSessionQuery();

  if (session.isPending) return <LoadingState />;
  if (session.isError) {
    return (
      <div className="mx-auto max-w-md p-8">
        <ErrorState error={session.error} onRetry={() => void session.refetch()} />
      </div>
    );
  }

  // Logged out: only logging in, signing up and looking at an invitation exist.
  if (session.data === null) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/invite/:token" element={<InvitePage session={null} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      {/* Outside the dashboard: accepting an invitation must work even for
          someone who belongs to no organisation yet. */}
      <Route path="/invite/:token" element={<InvitePage session={session.data} />} />
      <Route path="/login" element={<AfterLogin />} />
      <Route
        path="*"
        element={
          <AuthProvider session={session.data}>
            <Routes>
              <Route element={<Layout />}>
                <Route path="/endpoints" element={<EndpointsPage />} />
                <Route path="/deliveries" element={<DeliveriesPage />} />
                <Route path="/deliveries/:id" element={<DeliveryDetailPage />} />
                <Route path="/dead-letter" element={<DeadLetterPage />} />
                <Route path="/live" element={<LivePage />} />
                <Route path="/receivers" element={<ReceiversPage />} />
                <Route path="/api-keys" element={<ApiKeysPage />} />
                <Route path="/team" element={<TeamPage />} />
                <Route path="*" element={<Navigate to="/endpoints" replace />} />
              </Route>
            </Routes>
          </AuthProvider>
        }
      />
    </Routes>
  );
}
