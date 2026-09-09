import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import ProtectedRoute from "./components/ProtectedRoute";
import { Card, SectionLabel } from "./components/ui";
import { useAuth } from "./lib/auth";
import Login from "./pages/Login";
import Register from "./pages/Register";
import Applications from "./pages/platform/Applications";
import Clients from "./pages/Clients";
import Dashboard from "./pages/Dashboard";
import OrderCard from "./pages/OrderCard";
import OrderNew from "./pages/OrderNew";
import Orders from "./pages/Orders";
import Purchases from "./pages/Purchases";
import Staff from "./pages/Staff";
import Stock from "./pages/Stock";
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
  return <Dashboard />;
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
          <Route path="/orders" element={<Orders />} />
          <Route path="/orders/new" element={<OrderNew />} />
          <Route path="/orders/:id" element={<OrderCard />} />
          <Route path="/clients" element={<Clients />} />
          <Route path="/stock" element={<Stock />} />
          <Route path="/purchases" element={<Purchases />} />
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
