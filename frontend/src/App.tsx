import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useSessionQuery } from "./auth/AuthProvider";
import { Layout } from "./components/Layout";
import { ErrorState, LoadingState } from "./components/ui";
import { ApiKeysPage } from "./pages/ApiKeysPage";
import { LoginPage, RegisterPage } from "./pages/AuthPages";
import { DeadLetterPage, DeliveriesPage } from "./pages/DeliveriesPage";
import { DeliveryDetailPage } from "./pages/DeliveryDetailPage";
import { EndpointsPage } from "./pages/EndpointsPage";
import { LivePage } from "./pages/LivePage";
import { ReceiversPage } from "./pages/ReceiversPage";

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

  // Logged out: only the login and sign-up pages exist.
  if (session.data === null) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
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
          <Route path="*" element={<Navigate to="/endpoints" replace />} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}
