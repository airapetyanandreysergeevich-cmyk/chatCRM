import { prisma, withTenant } from "../lib/db";
import { ALL_PERMISSIONS, ROLE_PRESETS } from "../lib/permissions";
import { hashPassword } from "../lib/password";

/**
 * Статусы мастерской по умолчанию.
 *
 * Группа статуса — это колонка на главной: NEW — «Диагностика», WAITING —
 * «Согласование», IN_PROGRESS — «Ремонт», DONE — «Выдача». Поэтому статус
 * «Диагностика» лежит в NEW, а не в IN_PROGRESS: заказ, по которому ещё
 * выясняют неисправность, не должен попадать в колонку «Ремонт» — доска
 * тогда врёт про то, сколько техники реально чинится.
 *
 * Цвета взяты те же, что у колонок, чтобы список заказов и доска не
 * расходились.
 */
const DEFAULT_STATUSES = [
  { name: "Новый", group: "NEW" as const, color: "#FFF993", isInitial: true },
  { name: "Диагностика", group: "NEW" as const, color: "#FFF993", isInitial: false },
  { name: "Ожидает согласования", group: "WAITING" as const, color: "#FC7E68", isInitial: false },
  { name: "Ожидание запчасти", group: "WAITING" as const, color: "#FC7E68", isInitial: false },
  { name: "В работе", group: "IN_PROGRESS" as const, color: "#FE3E7D", isInitial: false },
  { name: "Тестирование", group: "IN_PROGRESS" as const, color: "#FE3E7D", isInitial: false },
  { name: "Готов", group: "DONE" as const, color: "#A5F88B", isInitial: false },
  { name: "Выдан", group: "CLOSED" as const, color: "#8A90A2", isInitial: false },
  { name: "Возврат без ремонта", group: "CANCELLED" as const, color: "#E38080", isInitial: false },
];

interface CreateTenantInput {
  name: string;
  slug: string;
  ownerEmail: string;
  ownerFullName: string;
  ownerPhone?: string;
  timezone?: string;
  /** Либо пароль в открытом виде, либо уже готовый хеш — при одобрении заявки
   *  пароль задал сам заявитель, и в открытом виде его у нас нет. */
  ownerPassword?: string;
  ownerPasswordHash?: string;
}

/**
 * Создаёт мастерскую вместе со всем, что нужно для первого входа:
 * филиал, пять ролей-пресетов, набор статусов, склад, кассу и учётку владельца.
 */
export async function createTenant(input: CreateTenantInput) {
  const tenant = await prisma.tenant.create({
    data: { name: input.name, slug: input.slug, timezone: input.timezone ?? "Europe/Moscow" },
  });

  const passwordHash =
    input.ownerPasswordHash ??
    (input.ownerPassword
      ? await hashPassword(input.ownerPassword)
      : (() => {
          throw new Error("Нужен ownerPassword или ownerPasswordHash");
        })());

  await withTenant(tenant.id, async (tx) => {
    const branch = await tx.branch.create({
      data: { tenantId: tenant.id, name: "Основной", isDefault: true },
    });

    await tx.role.createMany({
      data: ROLE_PRESETS.map((p) => ({
        tenantId: tenant.id,
        name: p.name,
        code: p.code,
        isSystem: true,
        permissions: p.permissions as unknown as string[],
      })),
    });

    await tx.orderStatus.createMany({
      data: DEFAULT_STATUSES.map((s, i) => ({ ...s, tenantId: tenant.id, sortOrder: i })),
    });

    await tx.warehouse.create({
      data: { tenantId: tenant.id, branchId: branch.id, name: "Основной склад", isDefault: true },
    });

    await tx.cashRegister.create({
      data: { tenantId: tenant.id, branchId: branch.id, name: "Касса", kind: "CASH" },
    });

    await tx.user.create({
      data: {
        tenantId: tenant.id,
        email: input.ownerEmail.toLowerCase().trim(),
        passwordHash,
        fullName: input.ownerFullName,
        phone: input.ownerPhone ?? null,
        branchId: branch.id,
        isOwner: true,
      },
    });
  });

  return tenant;
}

export const OWNER_PERMISSIONS = ALL_PERMISSIONS;
