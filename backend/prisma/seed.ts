/**
 * Создаёт собственника платформы при первом запуске.
 * Запускается вручную: npm run seed
 */
import { prisma } from "../src/lib/db";
import { hashPassword } from "../src/lib/password";

async function main() {
  const email = process.env.PLATFORM_OWNER_EMAIL;
  const password = process.env.PLATFORM_OWNER_PASSWORD;
  if (!email || !password) {
    throw new Error("Задайте PLATFORM_OWNER_EMAIL и PLATFORM_OWNER_PASSWORD");
  }

  const existing = await prisma.platformUser.findUnique({ where: { email } });
  if (existing) {
    console.log(`Собственник ${email} уже существует — ничего не делаю.`);
    return;
  }

  await prisma.platformUser.create({
    data: {
      email,
      passwordHash: await hashPassword(password),
      fullName: "Собственник платформы",
      role: "OWNER",
    },
  });
  console.log(`Создан собственник платформы: ${email}`);
}

main().finally(() => prisma.$disconnect());
