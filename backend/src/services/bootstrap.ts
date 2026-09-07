import { prisma } from "../lib/db";
import { hashPassword } from "../lib/password";

/**
 * Создаёт собственника платформы при первом старте.
 * Раньше это делал отдельный сид-скрипт, но в собранный образ он не попадает —
 * там нет исходников, только dist. Поэтому проверка живёт в самом приложении.
 * Повторные запуски ничего не меняют.
 */
export async function ensurePlatformOwner(): Promise<void> {
  const email = process.env.PLATFORM_OWNER_EMAIL?.toLowerCase().trim();
  const password = process.env.PLATFORM_OWNER_PASSWORD;
  if (!email || !password) return;

  const existing = await prisma.platformUser.count({ where: { role: "OWNER" } });
  if (existing > 0) return;

  await prisma.platformUser.create({
    data: {
      email,
      passwordHash: await hashPassword(password),
      fullName: "Собственник платформы",
      role: "OWNER",
    },
  });
  console.log(`Создан собственник платформы: ${email}. Смените пароль после первого входа.`);
}
