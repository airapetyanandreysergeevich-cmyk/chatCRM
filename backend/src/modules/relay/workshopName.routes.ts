import { Router, type Request } from "express";
import { z } from "zod";
import { clientIp, writeAudit } from "../../lib/audit";
import { prisma, withTenant } from "../../lib/db";
import { AppError, ah, badRequest, conflict, forbidden } from "../../lib/errors";
import { localProblem, looksLikeMailbox, nameProblem, normalizeName, splitWorkshopLogin, suggestLocal } from "../../lib/login";
import { PERMISSIONS } from "../../lib/permissions";
import { actorUserId, authenticate, currentTenantId, permissionsOf, requirePermission, requireTenant } from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";
import { cloudBase, readRemoteAccess, saveRemoteAccess } from "./remoteAccess";

/**
 * Имя мастерской — со стороны Основы.
 *
 * Владелец выбирает имя (lenina), и логины всех сотрудников становятся
 * nikita@lenina. Свободно ли имя, решает облако; как переименовать людей —
 * владелец, по таблице «было → станет». Здесь это собрано в три шага:
 * проверить имя, показать таблицу, закрепить имя и переименовать.
 *
 * Порядок последнего шага важен: сначала имя закрепляется в облаке, и только
 * потом переименовываются люди. Наоборот нельзя — облако может отказать
 * («занято»), а сотрудники уже с новыми логинами, которые никуда не ведут.
 * Если же сорвётся переименование после облака, ничего страшного: имя уже
 * наше, повтор с тем же именем облако примет, и таблица откроется снова.
 */

export const workshopNameRouter = Router();
workshopNameRouter.use(authenticate, requireTenant, enforceTenantStatus, requirePermission(PERMISSIONS.SETTINGS_MANAGE));

const tenantOf = (req: Request) => currentTenantId(req)!;

/** Переименовать всех может только тот, кто управляет и настройками, и сотрудниками. */
function assertCanRename(req: Request) {
  if (!permissionsOf(req).includes(PERMISSIONS.STAFF_MANAGE)) {
    throw forbidden("Менять логины сотрудников может только тот, кто управляет сотрудниками");
  }
}

/** Запрос в облако с ключом мастерской. */
async function cloud<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const saved = await readRemoteAccess();
  if (!saved?.key) {
    throw badRequest("Сначала подключите доступ из интернета — вставьте фразу подключения выше");
  }
  const base = cloudBase(saved.url);
  if (!base) throw badRequest("Не удалось понять адрес облака из фразы подключения");

  let res: Response;
  try {
    res = await fetch(`${base}/api/box${path}`, {
      method: init.method ?? "GET",
      headers: { "x-box-key": saved.key, ...(init.body ? { "content-type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new AppError(503, "Нет связи с облаком. Имя проверяется там — проверьте интернет и попробуйте ещё раз.");
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    if (res.status === 401) throw new AppError(502, "Облако не приняло ключ мастерской — вставьте фразу подключения заново");
    throw new AppError(res.status, data.error ?? "Облако не ответило");
  }
  return data;
}

// ---------------------------------------------------------------- проверка

workshopNameRouter.get(
  "/check",
  ah(async (req, res) => {
    const name = normalizeName(z.object({ name: z.string().max(60) }).parse(req.query).name);
    // Правила — сначала здесь: на каждую букву облако не дёргаем.
    const problem = nameProblem(name);
    if (problem) return res.json({ name, ok: false, reason: problem });
    const answer = await cloud<{ check: { name: string; ok: boolean; reason?: string } }>(
      `/name?check=${encodeURIComponent(name)}`
    );
    res.json(answer.check);
  })
);

// ---------------------------------------------------------------- таблица

interface PlanRow {
  id: string;
  fullName: string;
  isOwner: boolean;
  isActive: boolean;
  /** Логин сейчас. */
  login: string;
  /** Предложенная часть до @. */
  local: string;
  /** Почта для связи: нынешняя или настоящая почта из логина. */
  contactEmail: string;
}

async function planFor(req: Request, currentName: string): Promise<PlanRow[]> {
  const users = await withTenant(tenantOf(req), (tx) =>
    tx.user.findMany({
      where: { deletedAt: null },
      orderBy: [{ isOwner: "desc" }, { fullName: "asc" }],
      select: { id: true, fullName: true, isOwner: true, isActive: true, email: true, contactEmail: true },
    })
  );
  const used = new Set<string>();
  return users.map((u) => {
    // Уже логин этой мастерской — часть до @ оставляем как есть.
    const own = splitWorkshopLogin(u.email);
    const base = own && own.name === currentName ? own.local : suggestLocal(u.email, u.fullName);
    let local = base;
    for (let n = 2; used.has(local); n += 1) local = `${base}${n}`;
    used.add(local);
    return {
      id: u.id,
      fullName: u.fullName,
      isOwner: u.isOwner,
      isActive: u.isActive,
      login: u.email,
      local,
      contactEmail: u.contactEmail ?? (looksLikeMailbox(u.email) ? u.email : ""),
    };
  });
}

workshopNameRouter.get(
  "/plan",
  ah(async (req, res) => {
    assertCanRename(req);
    const saved = await readRemoteAccess();
    res.json({ current: saved?.name ?? "", rows: await planFor(req, saved?.name ?? "") });
  })
);

// ---------------------------------------------------------------- закрепить

const applySchema = z.object({
  name: z.string().max(60),
  logins: z
    .array(
      z.object({
        id: z.string().uuid(),
        local: z.string().max(60),
        contactEmail: z.string().trim().toLowerCase().email("Похоже, это не email").optional().or(z.literal("")),
      })
    )
    .min(1)
    .max(2000),
});

workshopNameRouter.post(
  "/",
  ah(async (req, res) => {
    assertCanRename(req);
    const body = applySchema.parse(req.body);
    const name = normalizeName(body.name);
    const problem = nameProblem(name);
    if (problem) throw badRequest(problem);

    // Таблица должна совпадать с сотрудниками: пока владелец её правил,
    // кого-то могли завести или удалить — такой человек остался бы со
    // старым логином, и никто бы этого не заметил.
    const tenantId = tenantOf(req);
    const users = await withTenant(tenantId, (tx) =>
      tx.user.findMany({ where: { deletedAt: null }, select: { id: true, email: true, contactEmail: true } })
    );
    const byId = new Map(users.map((u) => [u.id, u]));
    if (body.logins.length !== users.length || body.logins.some((l) => !byId.has(l.id))) {
      throw conflict("Список сотрудников изменился, пока открыта таблица — откройте её заново");
    }

    const next = body.logins.map((l) => ({ ...l, local: normalizeName(l.local) }));
    for (const l of next) {
      const bad = localProblem(l.local);
      if (bad) throw badRequest(`${bad}: «${l.local || "пусто"}»`);
    }
    const seen = new Map<string, number>();
    for (const l of next) seen.set(l.local, (seen.get(l.local) ?? 0) + 1);
    const twice = [...seen].filter(([, n]) => n > 1).map(([local]) => local);
    if (twice.length) throw badRequest(`Одинаковые логины: ${twice.join(", ")} — у каждого должен быть свой`);

    // Логин команды платформы с таким же адресом — вход общий, пересечься
    // они не должны даже теоретически.
    const logins = next.map((l) => `${l.local}@${name}`);
    const clash = await prisma.platformUser.findFirst({ where: { email: { in: logins } }, select: { email: true } });
    if (clash) throw conflict(`Логин ${clash.email} занят — выберите другой`);

    // Сначала облако: оно может сказать «занято».
    const claimed = await cloud<{ name: string }>("/name", { method: "PUT", body: { name } });

    const changed = await withTenant(tenantId, async (tx) => {
      const moving = next.filter((l) => byId.get(l.id)!.email !== `${l.local}@${name}`);
      // Два прохода: логины переставляются местами (у Анны станет логин,
      // который сейчас у Анны Петровны), и прямое переименование упёрлось
      // бы в уникальность почты посередине.
      for (const l of moving) {
        await tx.user.update({ where: { id: l.id }, data: { email: `${l.id}@renaming.invalid` } });
      }
      for (const l of next) {
        const was = byId.get(l.id)!;
        const login = `${l.local}@${name}`;
        const moved = was.email !== login;
        await tx.user.update({
          where: { id: l.id },
          data: {
            email: login,
            ...(moved ? { previousLogin: was.email } : {}),
            contactEmail: l.contactEmail ? l.contactEmail : null,
          },
        });
      }
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "Tenant",
        entityId: tenantId,
        action: "UPDATE",
        diff: { workshopName: claimed.name, loginsChanged: moving.length },
        ip: clientIp(req),
      });
      return moving.length;
    });

    const saved = await readRemoteAccess();
    if (saved) await saveRemoteAccess({ ...saved, name: claimed.name });

    res.json({ name: claimed.name, changed });
  })
);
