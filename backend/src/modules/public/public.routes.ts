import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { clientIp } from "../../lib/audit";
import { prisma } from "../../lib/db";
import { ah, conflict } from "../../lib/errors";
import { notifyPlatform } from "../../lib/notify";
import { hashPassword } from "../../lib/password";
import { isEmailTaken } from "../auth/auth.service";

export const publicRouter = Router();

/** Форма открыта всему интернету, поэтому лимит жёстче, чем на входе. */
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Слишком много заявок с одного адреса. Попробуйте позже." },
});

const registerSchema = z.object({
  workshopName: z.string().trim().min(2, "Укажите название мастерской").max(120),
  ownerFullName: z.string().trim().min(2, "Укажите имя").max(120),
  ownerEmail: z.string().trim().toLowerCase().email("Похоже, это не email"),
  ownerPhone: z.string().trim().min(6, "Укажите телефон").max(30),
  password: z.string().min(8, "Пароль от 8 символов"),
  city: z.string().trim().max(80).optional(),
  comment: z.string().trim().max(1000).optional(),
});

/**
 * Заявка на подключение мастерской.
 * Мастерская здесь НЕ создаётся: пока заявку не одобрили, в системе есть только эта строка.
 * Поэтому открытая форма не даёт боту ничего, кроме записи в таблице заявок.
 */
publicRouter.post(
  "/register",
  registerLimiter,
  ah(async (req, res) => {
    const body = registerSchema.parse(req.body);

    if (await isEmailTaken(body.ownerEmail)) throw conflict("Этот email уже используется");

    const pending = await prisma.tenantApplication.findFirst({
      where: { ownerEmail: body.ownerEmail, status: "PENDING" },
    });
    if (pending) throw conflict("Заявка с этим адресом уже отправлена и ждёт рассмотрения");

    const application = await prisma.tenantApplication.create({
      data: {
        workshopName: body.workshopName,
        ownerFullName: body.ownerFullName,
        ownerEmail: body.ownerEmail,
        ownerPhone: body.ownerPhone,
        passwordHash: await hashPassword(body.password),
        city: body.city || null,
        comment: body.comment || null,
        ip: clientIp(req),
        userAgent: req.headers["user-agent"]?.slice(0, 300) ?? null,
      },
    });

    await notifyPlatform({
      type: "APPLICATION_CREATED",
      applicationId: application.id,
      workshopName: application.workshopName,
      ownerFullName: application.ownerFullName,
      ownerPhone: application.ownerPhone,
      city: application.city,
    });

    res.status(201).json({ ok: true });
  })
);
