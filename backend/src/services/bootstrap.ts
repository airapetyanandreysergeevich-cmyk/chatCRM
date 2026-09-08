import { prisma } from "../lib/db";
import { hashPassword } from "../lib/password";

/**
 * Создаёт собственника платформы при первом старте.
 * Раньше это делал отдельный сид-скрипт, но в собранный образ он не попадает —
 * там нет исходников, только dist. Поэтому проверка живёт в самом приложении.
 * Повторные запуски ничего не меняют.
 */
export async function ensurePlatformOwner(): Promise<void> {
  // Управляющие символы отсекаем на всякий случай: при вставке команд в терминал
  // они попадают в .env вместе с адресом, и учётка создаётся с ненабираемым email.
  const email = process.env.PLATFORM_OWNER_EMAIL?.replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .toLowerCase();
  const password = process.env.PLATFORM_OWNER_PASSWORD;
  if (!email || !password) return;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error(
      `PLATFORM_OWNER_EMAIL не похож на адрес: ${JSON.stringify(email)}. ` +
        "Собственник не создан — поправьте значение в deploy/.env и перезапустите бэкенд."
    );
    return;
  }

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
