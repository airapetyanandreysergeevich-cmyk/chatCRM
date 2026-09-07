import { prisma, withTenant } from "../lib/db";
import { ALL_PERMISSIONS, ROLE_PRESETS } from "../lib/permissions";
import { hashPassword } from "../lib/password";

const DEFAULT_STATUSES = [
  { name: "Новый", group: "NEW" as const, color: "#3559F5", isInitial: true },
  { name: "Диагностика", group: "IN_PROGRESS" as const, color: "#5CC2D0", isInitial: false },
  { name: "Ожидает согласования", group: "WAITING" as const, color: "#F0B75E", isInitial: false },
  { name: "В работе", group: "IN_PROGRESS" as const, color: "#5CC2D0", isInitial: false },
  { name: "Ожидание запчасти", group: "WAITING" as const, color: "#F0B75E", isInitial: false },
  { name: "Тестирование", group: "IN_PROGRESS" as const, color: "#8FA7FF", isInitial: false },
  { name: "Готов", group: "DONE" as const, color: "#68C08D", isInitial: false },
  { name: "Выдан", group: "CLOSED" as const, color: "#186B41", isInitial: false },
  { name: "Возврат без ремонта", group: "CANCELLED" as const, color: "#E38080", isInitial: false },
];

interface CreateTenantInput {
  name: string;
  slug: string;
  ownerLogin: string;
  ownerPassword: string;
  ownerFullName: string;
  ownerEmail?: string;
  timezone?: string;
}

/**
 * Создаёт мастерскую вместе со всем, что нужно для первого входа:
 * филиал, пять ролей-пресетов, набор статусов, склад, кассу и учётку владельца.
 */
export async function createTenant(input: CreateTenantInput) {
  const tenant = await prisma.tenant.create({
    data: { name: input.name, slug: input.slug, timezone: input.timezone ?? "Europe/Moscow" },
  });

  const passwordHash = await hashPassword(input.ownerPassword);

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
        login: input.ownerLogin,
        email: input.ownerEmail,
        passwordHash,
        fullName: input.ownerFullName,
        branchId: branch.id,
        isOwner: true,
      },
    });
  });

  return tenant;
}

export const OWNER_PERMISSIONS = ALL_PERMISSIONS;
