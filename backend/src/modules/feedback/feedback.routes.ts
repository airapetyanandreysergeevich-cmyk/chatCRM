import { Router, type Request } from "express";
import { z } from "zod";
import { withTenant } from "../../lib/db";
import { ah, forbidden } from "../../lib/errors";
import { actorUserId, authenticate, currentTenantId, requireTenant } from "../../middleware/auth";

/**
 * Обратная связь от мастерской.
 *
 * Единственный канал, по которому владелец мастерской говорит с владельцем
 * платформы внутри самой программы. Раньше его не было вовсе: замечание
 * приходилось нести в мессенджер, где оно терялось между «здравствуйте» и
 * «спасибо».
 *
 * Отправлять может только владелец мастерской. Не из недоверия к
 * приёмщикам — просто адресат один, и разбирать он должен обращения, за
 * которыми кто-то стоит. Сотрудник со своим замечанием идёт к владельцу, а
 * тот решает, стоит ли оно разговора с платформой.
 *
 * Обращение не редактируется и не удаляется отправителем: это письмо, а не
 * заметка. Отправленное письмо назад не забирают.
 */

export const feedbackRouter = Router();
feedbackRouter.use(authenticate, requireTenant);

/**
 * Проверка на владельца.
 *
 * Отдельно от прав: право можно выдать, а владелец — один, и отвечает за
 * мастерскую именно он. Платформа в режиме «войти как» тоже не пишет
 * обращений — писать самой себе бессмысленно, и в списке такое обращение
 * выглядело бы жалобой мастерской, которой она не подавала.
 */
function requireWorkshopOwner(req: Request) {
  if (req.auth?.kind !== "tenant" || !req.auth.isOwner) {
    throw forbidden("Обратную связь отправляет владелец мастерской");
  }
}

const sendSchema = z.object({
  kind: z.enum(["REMARK", "WISH", "BUG"]),
  // Нижняя граница — чтобы не уходило «ошибка» без единой подробности:
  // такое обращение нельзя ни понять, ни ответить на него.
  text: z.string().trim().min(10, "Опишите подробнее — хотя бы пару предложений").max(4000, "Слишком длинно: до 4000 знаков"),
});

feedbackRouter.post(
  "/",
  ah(async (req, res) => {
    requireWorkshopOwner(req);
    const body = sendSchema.parse(req.body);

    // tenantId пишется явно, хотя прокси подставил бы его сам: без него не
    // сходятся типы Prisma. Так сделано во всех модулях — значение то же
    // самое, и прокси всё равно перезапишет его своим.
    const tenantId = currentTenantId(req)!;
    const created = await withTenant(tenantId, (tx) =>
      tx.feedback.create({
        data: { tenantId, kind: body.kind, text: body.text, authorId: actorUserId(req) },
        select: { id: true, kind: true, createdAt: true },
      })
    );

    res.status(201).json(created);
  })
);

/**
 * Свои прошлые обращения.
 *
 * Нужны не для красоты: без них человек не знает, дошло ли предыдущее, и
 * пишет то же самое второй раз. Видно и то, что обращение разобрали.
 */
feedbackRouter.get(
  "/",
  ah(async (req, res) => {
    requireWorkshopOwner(req);

    const items = await withTenant(currentTenantId(req)!, (tx) =>
      tx.feedback.findMany({
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { id: true, kind: true, text: true, handledAt: true, createdAt: true },
      })
    );

    res.json(items);
  })
);
