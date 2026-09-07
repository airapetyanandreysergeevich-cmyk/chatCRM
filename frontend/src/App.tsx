import { Route, Routes } from "react-router-dom";

function Placeholder({ title }: { title: string }) {
  return (
    <div className="min-h-full bg-canvas p-6">
      <div className="mx-auto max-w-3xl rounded-panel bg-surface p-6 shadow-card">
        <p className="text-xs font-extrabold uppercase tracking-[0.13em] text-ink-label">RepairShop</p>
        <h1 className="mt-2 text-2xl font-extrabold tracking-tight">{title}</h1>
        <p className="mt-3 text-ink-muted">Экран ещё не собран — каркас проекта.</p>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Placeholder title="Вход" />} />
      <Route path="/" element={<Placeholder title="Сводка" />} />
      <Route path="/orders" element={<Placeholder title="Заказы" />} />
      <Route path="/orders/new" element={<Placeholder title="Приём техники" />} />
      <Route path="/orders/:id" element={<Placeholder title="Карточка заказа" />} />
      <Route path="/master" element={<Placeholder title="Мои ремонты" />} />
      <Route path="/purchases" element={<Placeholder title="Заявки на закупку" />} />
      <Route path="/staff" element={<Placeholder title="Сотрудники" />} />
      <Route path="*" element={<Placeholder title="Страница не найдена" />} />
    </Routes>
  );
}
