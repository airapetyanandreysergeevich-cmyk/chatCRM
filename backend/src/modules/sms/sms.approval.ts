import type { Prisma } from "@prisma/client";
import { withTenant } from "../../lib/db";
import { notifyTenant } from "../../lib/notify";
import { writeAudit } from "../../lib/audit";
import {
  approvalOn,
  loadSettings,
  normalizePhone,
  orderFacts,
  render,
  sendSms,
  templateOf,
  type SmsSettings,
} from "./sms";

/**
 * Согласование по SMS.
 *
 * Мастер отправляет клиенту вопрос: что нужно сделать и сколько стоит.
 * Клиент отвечает на эту SMS — ответ приходит на телефон-шлюз, а тот
 * пересылает его сюда. Пересылает только с номеров, от которых ждут ответа:
 * список ему даёт сервер вместе с заданиями (watchList), поэтому личные SMS с
 * телефона никуда не уходят.
 *
 * «Да» — заказ переходит в статус «согласовано» (по умолчанию первый статус
 * «Ремонта»), «нет» — остаётся где был с пометкой, непонятный ответ — решает
 * мастер кнопкой. Обо всём — запись в истории ремонта и оповещение.
 */

export type Answer = "yes" | "no" | "unclear";
export type ApprovalState = "PENDING" | "YES" | "NO" | "UNCLEAR" | "CANCELLED" | "EXPIRED";

/** Сколько ждём ответа. Дальше номер с телефона не пересылается. */
export const APPROVAL_TTL_MS = 3 * 24 * 60 * 60 * 1000;

const YES = /^(да+|lf|ага|угу|ок|окей|ok|okay|хорошо|конечно|согласен|согласна|согласны|согласовано|делайте|делаем|давайте|давай|можно|yes|y|д|\+|1)$/;
const NO = /^(нет|ytn|не|неа|no|n|н|-|0|отказ|отказываюсь|против|не\s*надо|не\s*нужно|не\s*согласен|не\s*согласна|не\s*делайте|не\s*будем|не\s*буду|дорого)$/;

/**
 * Что ответил клиент. Смотрим на начало ответа: «Да, делайте» — согласие,
 * «Нет, дорого» — отказ. С вопросом («да, а сколько по времени?») — решает
 * человек: согласие с условием автоматом не засчитываем.
 */
export function parseAnswer(raw: string): Answer {
  const text = raw.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
  if (!text) return "unclear";
  if (text.includes("?")) return "unclear";
  // Первое слово (или «не надо» из двух) — без знаков вокруг.
  const words = text.replace(/[.,!;:()"«»]+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return /^\+/.test(text) ? "yes" : /^-/.test(text) ? "no" : "unclear";
  const two = words.slice(0, 2).join(" ");
  if (NO.test(two) || NO.test(words[0])) return "no";
  if (YES.test(words[0])) {
    // «Да нет, не надо» — отказ, сказанный по-русски.
    if (words.slice(1).some((w) => w === "нет" || w === "не")) return "unclear";
    return "yes";
  }
  if (text === "+" || text === "++") return "yes";
  if (text === "-" || text === "--") return "no";
  return "unclear";
}

/** Просроченные «ждём ответа» — в EXPIRED. Ленивое: перед каждым чтением. */
export async function expireApprovals(tx: Prisma.TransactionClient) {
  await tx.smsApproval.updateMany({ where: { status: "PENDING", expiresAt: { lt: new Date() } }, data: { status: "EXPIRED" } });
}

/** Номера, от которых телефон должен переслать ответ. */
export async function watchList(tx: Prisma.TransactionClient): Promise<string[]> {
  await expireApprovals(tx);
  const rows = await tx.smsApproval.findMany({ where: { status: "PENDING" }, select: { phone: true }, distinct: ["phone"], take: 500 });
  return rows.map((r) => r.phone);
}

/** Какие статусы считать «на согласовании» и «согласовано». */
export async function approvalStatuses(tx: Prisma.TransactionClient, s: SmsSettings) {
  const all = await tx.orderStatus.findMany({ orderBy: { sortOrder: "asc" }, select: { id: true, name: true, group: true } });
  const waiting =
    all.find((x) => x.id === s.approval.statusId) ??
    all.find((x) => x.group === "WAITING" && /соглас/i.test(x.name)) ??
    all.find((x) => x.group === "WAITING") ??
    null;
  const yes = all.find((x) => x.id === s.approval.yesStatusId) ?? all.find((x) => x.group === "IN_PROGRESS") ?? null;
  return { waiting, yes, all };
}

export interface ApprovalView {
  id: string;
  status: ApprovalState;
  phone: string;
  createdAt: Date;
  expiresAt: Date;
  replyText: string | null;
  repliedAt: Date | null;
  decidedBy: string | null;
  author: string | null;
}

/** Последнее согласование заказа — для карточки. */
export async function lastApproval(tx: Prisma.TransactionClient, orderId: string): Promise<ApprovalView | null> {
  await expireApprovals(tx);
  const a = await tx.smsApproval.findFirst({ where: { orderId, status: { not: "CANCELLED" } }, orderBy: { createdAt: "desc" } });
  if (!a) return null;
  const ids = [a.decidedById, a.createdById].filter((v): v is string => !!v);
  const users = ids.length ? await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } }) : [];
  const name = (id: string | null) => (id ? (users.find((u) => u.id === id)?.fullName ?? null) : null);
  return {
    id: a.id,
    status: a.status as ApprovalState,
    phone: a.phone,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
    replyText: a.replyText,
    repliedAt: a.repliedAt,
    decidedBy: name(a.decidedById),
    author: name(a.createdById),
  };
}

/**
 * Спросить клиента. Прежний вопрос по этому заказу снимается: ответ на старый
 * текст с другой суммой засчитывать нельзя.
 */
export async function startApproval(
  tenantId: string,
  orderId: string,
  text: string,
  userId: string | null
): Promise<{ ok: true; smsId: string } | { ok: false; error: string; smsId?: string }> {
  const facts = await withTenant(tenantId, (tx) => orderFacts(tx, tenantId, orderId));
  if (!facts) return { ok: false, error: "Заказ не найден" };
  if (!facts.phone) return { ok: false, error: "У клиента не указан телефон" };
  const sms = await sendSms(tenantId, {
    orderId,
    customerId: facts.order.customer?.id ?? null,
    phone: facts.phone,
    text,
    kind: "approval",
    userId,
  });
  if (sms.status === "FAILED") return { ok: false, error: sms.error ?? "SMS не отправлена", smsId: sms.id };
  await withTenant(tenantId, async (tx) => {
    await tx.smsApproval.updateMany({ where: { orderId, status: { in: ["PENDING", "UNCLEAR"] } }, data: { status: "CANCELLED" } });
    await tx.smsApproval.create({
      data: {
        tenantId,
        orderId,
        smsId: sms.id,
        phone: facts.phone!,
        createdById: userId,
        expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
      },
    });
    await systemNote(tx, tenantId, orderId, `Клиенту отправлено согласование по SMS: «${text}»`);
  });
  return { ok: true, smsId: sms.id };
}

/** Запись программы в истории ремонта: видна всем, кто открывает заказ. */
async function systemNote(tx: Prisma.TransactionClient, tenantId: string, orderId: string, text: string) {
  await tx.orderMessage.create({ data: { tenantId, orderId, authorId: null, system: true, text } });
}

/**
 * Пришла SMS с номера, от которого ждут ответа. Относим её к последнему
 * вопросу этому номеру. Номер не ждём — ничего не делаем и ничего не храним.
 */
export async function handleIncoming(tenantId: string, from: string, text: string): Promise<{ matched: boolean; answer?: Answer }> {
  const phone = normalizePhone(from);
  if (!phone) return { matched: false };
  const found = await withTenant(tenantId, async (tx) => {
    await expireApprovals(tx);
    return tx.smsApproval.findFirst({ where: { phone, status: "PENDING" }, orderBy: { createdAt: "desc" } });
  });
  if (!found) return { matched: false };
  const answer = parseAnswer(text);
  await settle(tenantId, found.id, answer, { reply: text.trim().slice(0, 500), userId: null });
  return { matched: true, answer };
}

/** Решение сотрудника: ответ был непонятен или клиент ответил по телефону. */
export async function decideApproval(
  tenantId: string,
  orderId: string,
  answer: "yes" | "no",
  userId: string | null
): Promise<boolean> {
  const found = await withTenant(tenantId, async (tx) => {
    await expireApprovals(tx);
    return tx.smsApproval.findFirst({
      where: { orderId, status: { in: ["PENDING", "UNCLEAR"] } },
      orderBy: { createdAt: "desc" },
    });
  });
  if (!found) return false;
  await settle(tenantId, found.id, answer, { userId });
  return true;
}

/** Снять вопрос: передумали спрашивать. Ответ на него больше не засчитается. */
export async function cancelApproval(tenantId: string, orderId: string, userId: string | null): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const n = await tx.smsApproval.updateMany({ where: { orderId, status: { in: ["PENDING", "UNCLEAR"] } }, data: { status: "CANCELLED", decidedById: userId } });
    if (n.count) await systemNote(tx, tenantId, orderId, "Согласование по SMS отменено — ответ клиента больше не засчитается");
    return n.count > 0;
  });
}

/**
 * Итог согласования: статус заказа, запись в истории, оповещение, ответ
 * клиенту. Сеть (SMS и push) — после транзакции.
 */
async function settle(
  tenantId: string,
  approvalId: string,
  answer: Answer,
  opts: { reply?: string; userId: string | null }
): Promise<void> {
  const outcome = await withTenant(tenantId, async (tx) => {
    const a = await tx.smsApproval.findFirst({ where: { id: approvalId } });
    if (!a) return null;
    const settings = await loadSettings(tx);
    const order = await tx.order.findFirst({
      where: { id: a.orderId, deletedAt: null },
      select: { id: true, number: true, statusId: true, assignedMasterId: true, status: { select: { group: true, name: true } } },
    });
    const status: ApprovalState = answer === "yes" ? "YES" : answer === "no" ? "NO" : "UNCLEAR";
    await tx.smsApproval.update({
      where: { id: a.id },
      data: {
        status,
        ...(opts.reply !== undefined ? { replyText: opts.reply, repliedAt: new Date() } : {}),
        ...(opts.userId ? { decidedById: opts.userId } : {}),
      },
    });
    if (!order) return null;

    const quote = opts.reply !== undefined ? ` «${opts.reply}»` : "";
    const who = opts.userId ? (await tx.user.findFirst({ where: { id: opts.userId }, select: { fullName: true } }))?.fullName : null;
    let moved: string | null = null;
    if (answer === "yes") {
      // Переводим, только если заказ всё ещё ждёт согласования: если его уже
      // двинули руками — не откатываем чужую работу.
      const { yes } = await approvalStatuses(tx, settings);
      if (yes && order.status.group === "WAITING" && order.statusId !== yes.id) {
        await tx.order.update({ where: { id: order.id }, data: { statusId: yes.id } });
        await tx.orderStatusHistory.create({
          data: {
            tenantId,
            orderId: order.id,
            fromStatusId: order.statusId,
            toStatusId: yes.id,
            userId: opts.userId,
            comment: opts.userId ? "Согласовано (отметил сотрудник)" : "Клиент согласился по SMS",
          },
        });
        await writeAudit(tx, {
          tenantId,
          userId: opts.userId,
          entity: "Order",
          entityId: order.id,
          action: "STATUS",
          diff: { to: yes.name, by: opts.userId ? "согласование вручную" : "согласование по SMS" },
          ip: null,
        });
        moved = yes.name;
      }
    }
    const line =
      answer === "yes"
        ? opts.userId
          ? `Согласование: ${who ?? "сотрудник"} отметил, что клиент согласен.`
          : `Клиент согласился по SMS:${quote}.`
        : answer === "no"
          ? opts.userId
            ? `Согласование: ${who ?? "сотрудник"} отметил, что клиент отказался.`
            : `Клиент отказался по SMS:${quote}.`
          : `Клиент ответил на согласование по SMS:${quote}. Ответ непонятен — решите в заказе: «Согласен» или «Отказался».`;
    await systemNote(tx, tenantId, order.id, moved ? `${line} Заказ переведён в «${moved}».` : line);

    const facts = await orderFacts(tx, tenantId, order.id);
    const replyText =
      opts.userId === null && facts?.phone && approvalOn(settings)
        ? answer === "yes" && settings.approval.replyYes
          ? render(templateOf(settings, "approvalYes"), facts.values)
          : answer === "no" && settings.approval.replyNo
            ? render(templateOf(settings, "approvalNo"), facts.values)
            : null
        : null;
    return { order, moved, replyText, phone: facts?.phone ?? null, customerId: facts?.order.customer?.id ?? null };
  });
  if (!outcome) return;

  if (outcome.replyText && outcome.phone) {
    await sendSms(tenantId, {
      orderId: outcome.order.id,
      customerId: outcome.customerId,
      phone: outcome.phone,
      text: outcome.replyText,
      kind: "approval_reply",
      userId: null,
    }).catch(() => undefined);
  }

  const title =
    answer === "yes"
      ? `Клиент согласен — ${outcome.order.number}`
      : answer === "no"
        ? `Клиент отказался — ${outcome.order.number}`
        : `Непонятный ответ клиента — ${outcome.order.number}`;
  void notifyTenant(tenantId, {
    event: "order.approval",
    title,
    body:
      answer === "yes"
        ? outcome.moved
          ? `Заказ переведён в «${outcome.moved}». Можно начинать ремонт.`
          : "Согласие получено."
        : answer === "no"
          ? "Ремонт не делаем — сообщите клиенту, когда забрать технику."
          : opts.reply
            ? `«${opts.reply.slice(0, 120)}» — решите в заказе.`
            : "Решите в заказе.",
    url: `/orders/${outcome.order.id}`,
    targetUserId: outcome.order.assignedMasterId,
    exceptUserId: opts.userId,
    payload: { orderId: outcome.order.id },
  });
}
