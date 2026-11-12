import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useSessionQuery } from "./auth/AuthProvider";
import { Layout } from "./components/Layout";
import { ErrorState, LoadingState } from "./components/ui";
import { ApiKeysPage } from "./pages/ApiKeysPage";
import { LoginPage, RegisterPage } from "./pages/AuthPages";
import { EndpointsPage } from "./pages/EndpointsPage";
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
          <Route path="/receivers" element={<ReceiversPage />} />
          <Route path="/api-keys" element={<ApiKeysPage />} />
          <Route path="*" element={<Navigate to="/endpoints" replace />} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}
