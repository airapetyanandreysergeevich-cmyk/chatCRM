import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Spinner } from "./ui";

export default function ProtectedRoute() {
  const { status } = useAuth();
  if (status === "loading") return <Spinner label="Проверяем сессию" />;
  if (status === "anon") return <Navigate to="/login" replace />;
  return <Outlet />;
}
