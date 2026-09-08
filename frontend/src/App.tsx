import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import ProtectedRoute from "./components/ProtectedRoute";
import { Card, SectionLabel } from "./components/ui";
import { useAuth } from "./lib/auth";
import Login from "./pages/Login";
import Register from "./pages/Register";
import Applications from "./pages/platform/Applications";
import Staff from "./pages/Staff";
import Tenants from "./pages/platform/Tenants";

function Soon({ title }: { title: string }) {
  return (
    <Card>
      <SectionLabel>Скоро</SectionLabel>
      <h1 className="mt-2 text-2xl font-extrabold tracking-tight">{title}</h1>
      <p className="mt-2 text-ink-muted">Этот раздел ещё не собран.</p>
    </Card>
  );
}

/** Куда попадает пользователь после входа — зависит от того, кто он. */
function Home() {
  const { me } = useAuth();
  if (me?.kind === "platform" && !me.impersonating) return <Navigate to="/platform/tenants" replace />;
  return <Soon title="Сводка" />;
}

export default function App() {
  const { status } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={status === "ready" ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/register" element={status === "ready" ? <Navigate to="/" replace /> : <Register />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<Layout />}>
          <Route path="/" element={<Home />} />
          <Route path="/orders" element={<Soon title="Заказы" />} />
          <Route path="/staff" element={<Staff />} />
          <Route path="/platform/tenants" element={<Tenants />} />
          <Route path="/platform/applications" element={<Applications />} />
          <Route path="/platform/admins" element={<Soon title="Администраторы платформы" />} />
          <Route path="/platform/audit" element={<Soon title="Журнал платформы" />} />
          <Route path="*" element={<Soon title="Страница не найдена" />} />
        </Route>
      </Route>
    </Routes>
  );
}
