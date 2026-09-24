import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z, ZodError } from "zod";
import { prisma, withTenant } from "../../lib/db";
import { ah, unauthorized } from "../../lib/errors";
import { authenticate, currentTenantId, permissionsOf } from "../../middleware/auth";
import { isWorkshopLogin, localProblem, splitWorkshopLogin } from "../../lib/login";
import { findWorkshop } from "../relay/boxes.service";
import { localLoginDomain } from "../relay/remoteAccess";
import { relayHub } from "../relay/relay.instance";
import { login, refreshCookieOptions, REFRESH_COOKIE, revokeRefresh, rotateRefresh } from "./auth.service";

export const authRouter = Router();

/** Подбор пароля по форме входа — самая дешёвая атака, поэтому лимит стоит до всего остального. */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Слишком много попыток входа. Попробуйте через 15 минут." },
});

/**
 * На входе принимаем три вида логина:
 *   - почту — облачные сотрудники и команда платформы;
 *   - логин мастерской `nikita@lenina` — без точки после @ (см. lib/login);
 *   - в локальной сети — просто `nikita`: Основа допишет своё имя сама.
 */
const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, "Укажите логин"),
  password: z.string().min(1, "Укажите пароль"),
});

const asEmail = z.string().email();

function loginProblem(login: string): string | null {
  if (asEmail.safeParse(login).success || isWorkshopLogin(login)) return null;
  if (!login.includes("@") && !localProblem(login)) return null;
  return "Похоже, это не email и не логин вида имя@мастерская";
}

/**
 * Вход сотрудника коробочной мастерской с общего сайта.
 *
 * Такой человек живёт не в облаке, а в Основе своего владельца, и пароля его
 * у нас нет и быть не должно. По части логина после @ облако находит
 * мастерскую и передаёт туда обычный вход через туннель; пароль проверяет
 * сама Основа, а облако лишь возвращает её ответ.
 *
 * Адрес мастерской наружу не выходит, пока пароль не подошёл: он случайный
 * как раз затем, чтобы его нельзя было собрать перебором имён.
 */
async function loginThroughBox(
  login: { local: string; name: string },
  password: string,
  req: Request,
  res: Response
): Promise<void> {
  const found = await findWorkshop(login.name);
  const hub = relayHub();
  if (!found.found) {
    // Имя мастерской — не секрет: его знают все её сотрудники. Честный ответ
    // экономит им звонок начальнику: опечатка видна сразу.
    throw unauthorized(
      found.renamedTo
        ? `Мастерская сменила имя: теперь входите как ${login.local}@${found.renamedTo}`
        : `Мастерской «${login.name}» нет. Проверьте часть логина после @`
    );
  }
  if (!hub) throw unauthorized("Неверный логин или пароль");

  const reply = await hub.request(found.code, "/api/auth/login", {
    method: "POST",
    // Адрес человека передаём дальше: Основа считает попытки входа по нему.
    // Без этого все входы из интернета пришли бы к ней с одного адреса —
    // адреса узла связи, — и десять чужих ошибок за четверть часа заперли бы
    // вход снаружи всей мастерской.
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": req.ip ?? "",
      ...(req.headers["user-agent"] ? { "user-agent": String(req.headers["user-agent"]).slice(0, 300) } : {}),
    },
    body: Buffer.from(JSON.stringify({ email: `${login.local}@${found.name}`, password }), "utf8"),
  });

  if (reply.offline || reply.status === 502 || reply.status === 503 || reply.status === 504) {
    res.status(503).json({
      error:
        "Мастерская сейчас не на связи. Вход работает, пока в ней включён компьютер с программой — попробуйте позже.",
    });
    return;
  }

  // Ответ Основы отдаём как есть: она одна знает, верен ли пароль, и она же
  // считает попытки. Ни логина, ни пароля у облака не остаётся.
  if (reply.status >= 400) {
    let said: unknown = null;
    try {
      said = JSON.parse(reply.body.toString("utf8"));
    } catch {
      /* не json — скажем своими словами */
    }
    res.status(reply.status).json(said ?? { error: "Неверный логин или пароль" });
    return;
  }

  // Печенье сессии узел связи уже пометил путём /b/<код>/ — просто передаём.
  const cookies = reply.headers["set-cookie"];
  if (cookies) res.setHeader("set-cookie", cookies);
  res.json({ kind: "box", redirect: `/b/${found.code}/` });
}

/**
 * Вход один на всех: и для сотрудников мастерских, и для команды платформы.
 * Кто именно пришёл, решает сервер по логину — выбирать ничего не нужно.
 * Куда вести дальше, фронтенд узнаёт из ответа и из /auth/me.
 */
authRouter.post(
  "/login",
  loginLimiter,
  ah(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const problem = loginProblem(body.email);
    if (problem) throw new ZodError([{ code: "custom", path: ["email"], message: problem }]);

    // Логин мастерской на облачном сервере — вход в её Основу через туннель.
    // В самой Основе узла связи нет, и такой логин — просто её собственный.
    const workshop = relayHub() ? splitWorkshopLogin(body.email) : null;
    if (workshop) return loginThroughBox(workshop, body.password, req, res);

    const { accessToken, refresh, kind } = await login({ ...body, req });
    res.cookie(REFRESH_COOKIE, refresh, refreshCookieOptions());
    res.json({ accessToken, kind });
  })
);

authRouter.post(
  "/refresh",
  ah(async (req, res) => {
    const raw = req.cookies?.[REFRESH_COOKIE];
    if (!raw) throw unauthorized("Нет сессии");
    const { accessToken, refresh } = await rotateRefresh(raw, req);
    res.cookie(REFRESH_COOKIE, refresh, refreshCookieOptions());
    res.json({ accessToken });
  })
);

authRouter.post(
  "/logout",
  ah(async (req, res) => {
    await revokeRefresh(req.cookies?.[REFRESH_COOKIE]);
    res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(), maxAge: undefined });
    res.json({ ok: true });
  })
);

authRouter.get(
  "/me",
  authenticate,
  ah(async (req, res) => {
    if (req.auth!.kind === "platform") {
      const auth = req.auth as Extract<typeof req.auth, { kind: "platform" }>;
      const user = await prisma.platformUser.findUnique({ where: { id: auth.platformUserId } });
      if (!user) throw unauthorized();
      const tenantId = currentTenantId(req);
      const tenant = tenantId ? await prisma.tenant.findUnique({ where: { id: tenantId } }) : null;
      return res.json({
        kind: "platform",
        platformUser: { id: user.id, email: user.email, fullName: user.fullName, role: user.role },
        impersonating: tenant ? { id: tenant.id, name: tenant.name, slug: tenant.slug } : null,
        permissions: permissionsOf(req),
      });
    }

    const auth = req.auth as Extract<typeof req.auth, { kind: "tenant" }>;
    const data = await withTenant(auth.tenantId, async (tx) => {
      const user = await tx.user.findFirst({ where: { id: auth.userId }, include: { role: true, branch: true } });
      if (!user) throw unauthorized();
      return user;
    });
    const tenant = await prisma.tenant.findUnique({ where: { id: auth.tenantId } });
    res.json({
      kind: "tenant",
      user: {
        id: data.id,
        email: data.email,
        fullName: data.fullName,
        phone: data.phone,
        isOwner: data.isOwner,
        role: data.role ? { id: data.role.id, name: data.role.name, code: data.role.code } : null,
        branch: data.branch ? { id: data.branch.id, name: data.branch.name } : null,
      },
      tenant: tenant && { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status },
      // Имя мастерской для логинов (nikita@lenina) — только у Основы, где оно
      // выбрано. Форма сотрудника по нему дописывает окончание логина сама.
      loginDomain: (await localLoginDomain()) || null,
      permissions: permissionsOf(req),
    });
  })
);
