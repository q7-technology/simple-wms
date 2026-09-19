import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext";

export function RequireAuth() {
  const { ready, user } = useAuth();
  const location = useLocation();
  if (!ready) return <div className="p-6 text-muted text-sm">Loading…</div>;
  if (!user) return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}
