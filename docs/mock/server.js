"use strict";

/**
 * Витрина для снимков экрана: настоящий собранный интерфейс + выдуманные
 * данные вместо базы. Нужна ровно затем, чтобы в инструкции были картинки
 * из самой программы, а не нарисованные от руки.
 */

const express = require("/home/claude/be/node_modules/express");
const path = require("path");

const app = express();
app.use(express.json({ limit: "5mb" }));

const DIST = "/home/claude/fe/dist";

const PERMS = [
  "orders.view.all", "orders.view.assigned", "orders.view.delivery",
  "orders.create", "orders.edit", "orders.status", "orders.status.own",
  "orders.issue", "orders.delete", "orders.customer_contacts", "orders.cost",
  "customers.view", "customers.edit",
  "stock.view", "stock.move", "stock.write_off.own", "stock.inventory",
  "purchases.view", "purchases.create", "purchases.approve",
  "finance.view", "finance.payment", "finance.manage",
  "salary.view.all", "salary.view.own", "salary.manage",
  "reports.view", "reports.finance",
  "staff.manage", "roles.manage", "settings.manage",
];

const ME = {
  kind: "tenant",
  user: {
    id: "u1",
    email: "vladelec@remont.local",
    fullName: "Андрей Айрапетян",
    phone: "+7 900 123-45-67",
    isOwner: true,
    role: null,
    branch: null,
  },
  tenant: { id: "t1", name: "Сервис на Ленина", slug: "servis-na-lenina", status: "ACTIVE" },
  permissions: PERMS,
};

const ROLES = [
  { id: "r1", name: "Управляющий", code: "MANAGER", isSystem: true, permissions: PERMS.slice(0, 20) },
  { id: "r2", name: "Приёмщик", code: "RECEPTION", isSystem: true, permissions: PERMS.slice(0, 13) },
  { id: "r3", name: "Мастер", code: "MASTER", isSystem: true, permissions: ["orders.view.assigned", "orders.status.own"] },
  { id: "r4", name: "Бухгалтер", code: "ACCOUNTANT", isSystem: true, permissions: ["finance.view", "reports.finance"] },
  { id: "r5", name: "Курьер", code: "COURIER", isSystem: true, permissions: ["orders.view.delivery"] },
];

const ago = (h) => new Date(Date.now() - h * 3600_000).toISOString();

const STAFF = [
  { id: "u1", fullName: "Андрей Айрапетян", phone: "+7 900 123-45-67", email: "vladelec@remont.local",
    isOwner: true, isActive: true, lastLoginAt: ago(1), androidAppAt: ago(200), role: null },
  { id: "u2", fullName: "Ирина Ковалёва", phone: "+7 900 222-11-30", email: "priem@remont.local",
    isOwner: false, isActive: true, lastLoginAt: ago(3), androidAppAt: ago(40),
    role: { id: "r2", name: "Приёмщик", code: "RECEPTION" } },
  { id: "u3", fullName: "Сергей Панов", phone: null, email: "master1@remont.local",
    isOwner: false, isActive: true, lastLoginAt: ago(5), androidAppAt: null,
    role: { id: "r3", name: "Мастер", code: "MASTER" } },
  { id: "u4", fullName: "Дмитрий Лыков", phone: "+7 900 777-04-12", email: "master2@remont.local",
    isOwner: false, isActive: true, lastLoginAt: ago(26), androidAppAt: ago(300),
    role: { id: "r3", name: "Мастер", code: "MASTER" } },
  { id: "u5", fullName: "Ольга Шестакова", phone: null, email: "buh@remont.local",
    isOwner: false, isActive: false, lastLoginAt: ago(1300), androidAppAt: null,
    role: { id: "r4", name: "Бухгалтер", code: "ACCOUNTANT" } },
];

const st = (id, name, group, color) => ({ id, name, group, color });

const card = (n, kind, brand, model, stage, master, hours, urgent = false) => ({
  id: "o" + n,
  number: n,
  isUrgent: urgent,
  acceptedAt: ago(hours),
  dueAt: ago(hours - 72),
  status: stage,
  device: { kind, brand, model },
  master: master ? { id: "u3", fullName: master } : null,
  customer: { id: "c" + n, type: "INDIVIDUAL", name: ["Кузнецов И.", "ООО «Ветер»", "Сафина Л.", "Гурьев П.", "Мирзоев А.", "Тихонова Е."][n % 6] },
});

const SUMMARY = {
  scope: "all",
  stages: [
    {
      key: "NEW", total: 3,
      items: [
        card("0412", "Ноутбук", "Lenovo", "IdeaPad 3", st("s1", "Диагностика", "NEW", "#5b8def"), null, 4),
        card("0411", "Телефон", "Samsung", "A54", st("s1", "Диагностика", "NEW", "#5b8def"), null, 7, true),
        card("0409", "Моноблок", "HP", "ProOne 440", st("s1", "Диагностика", "NEW", "#5b8def"), null, 20),
      ],
    },
    {
      key: "WAITING", total: 2,
      items: [
        card("0407", "Ноутбук", "ASUS", "X515", st("s2", "Ожидание запчасти", "WAITING", "#d9a441"), "Сергей Панов", 30),
        card("0405", "Телефон", "Xiaomi", "Redmi Note 12", st("s3", "Согласование сметы", "WAITING", "#d9a441"), "Дмитрий Лыков", 48),
      ],
    },
    {
      key: "IN_PROGRESS", total: 2,
      items: [
        card("0403", "Ноутбук", "Acer", "Aspire 5", st("s4", "Ремонт", "IN_PROGRESS", "#7a6cf0"), "Сергей Панов", 52),
        card("0402", "Планшет", "Apple", "iPad 9", st("s4", "Ремонт", "IN_PROGRESS", "#7a6cf0"), "Дмитрий Лыков", 60, true),
      ],
    },
    {
      key: "DONE", total: 2,
      items: [
        card("0399", "Телефон", "Apple", "iPhone 12", st("s5", "Готов к выдаче", "DONE", "#4caf82"), "Сергей Панов", 74),
        card("0398", "Ноутбук", "Dell", "Vostro 3520", st("s5", "Готов к выдаче", "DONE", "#4caf82"), "Дмитрий Лыков", 90),
      ],
    },
  ],
};

const FEEDBACK = [
  { id: "f1", kind: "WISH", createdAt: ago(20), handledAt: null,
    text: "Хорошо бы в списке заказов видеть сразу, кто из мастеров сейчас свободен." },
  { id: "f2", kind: "BUG", createdAt: ago(75), handledAt: ago(60),
    text: "При печати квитанции на втором компьютере пропадает логотип мастерской." },
  { id: "f3", kind: "REMARK", createdAt: ago(130), handledAt: ago(120),
    text: "Кнопка «Выдать» слишком близко к «Отменить» — приёмщик дважды промахнулся." },
];

const json = (res, data) => res.json(data);

// Вход притворяется настоящим: пока не вошли, продление сессии отвечает
// отказом — иначе страница входа мелькает и сразу уходит на сводку, и снять
// её нечем.
let signedIn = false;
app.post("/api/auth/login", (_req, res) => {
  signedIn = true;
  json(res, { accessToken: "demo" });
});
app.post("/api/auth/refresh", (_req, res) =>
  signedIn ? json(res, { accessToken: "demo" }) : res.status(401).json({ error: "Нет сессии" })
);
app.post("/api/auth/logout", (_req, res) => {
  signedIn = false;
  json(res, {});
});
app.post("/api/demo/reset", (_req, res) => {
  signedIn = false;
  json(res, { ok: true });
});
app.get("/api/auth/me", (_req, res) => json(res, ME));

app.get("/api/settings/appearance", (_req, res) => json(res, { theme: null, branding: { logo: null, printNote: null } }));
app.get("/api/push/key", (_req, res) => json(res, { configured: false, publicKey: null }));

app.get("/api/summary", (_req, res) => json(res, SUMMARY));
app.get("/api/staff", (_req, res) => json(res, STAFF));
app.get("/api/roles", (_req, res) => json(res, ROLES));
app.get("/api/feedback", (_req, res) => json(res, FEEDBACK));
app.post("/api/feedback", (_req, res) => json(res, { id: "f0" }));

app.get("/api/notifications/settings", (_req, res) => json(res, {}));

// Плитка Windows показывается, только когда установщик действительно лежит.
app.head("/download/FineCRM-setup.exe", (_req, res) => res.status(200).end());
app.get("/download/FineCRM-setup.exe", (_req, res) => res.status(200).end());

app.use("/api", (_req, res) => json(res, []));

app.use(express.static(DIST));
app.get("*", (_req, res) => res.sendFile(path.join(DIST, "index.html")));

app.listen(4100, "127.0.0.1", () => console.log("витрина на http://127.0.0.1:4100"));
