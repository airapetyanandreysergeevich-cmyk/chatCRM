/**
 * Смена пароля любой учётной записи — и платформенной, и сотрудника мастерской.
 *
 * Пароль читается со стандартного ввода, а не из аргументов командной строки:
 * аргументы видны в списке процессов и оседают в истории оболочки.
 *
 *   printf '%s' 'новый-пароль' | node dist/cli/set-password.js user@example.com
 *
 * Проще запускать обёрткой: bash deploy/set-password.sh user@example.com
 */
import { prisma, withPlatform, withTenant } from "../lib/db";
import { hashPassword } from "../lib/password";

async function readPasswordFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

async function main() {
  const email = process.argv[2]?.toLowerCase().trim();
  if (!email) throw new Error("Укажите email: node dist/cli/set-password.js user@example.com");

  const password = await readPasswordFromStdin();
  if (password.length < 8) throw new Error("Пароль должен быть не короче 8 символов");

  const passwordHash = await hashPassword(password);
  const now = new Date();

  const platformUser = await prisma.platformUser.findUnique({ where: { email } });
  if (platformUser) {
    await prisma.platformUser.update({ where: { id: platformUser.id }, data: { passwordHash } });
    await prisma.session.updateMany({
      where: { platformUserId: platformUser.id, revokedAt: null },
      data: { revokedAt: now },
    });
    console.log(`Пароль изменён: ${email} — пользователь платформы. Все сессии погашены.`);
    return;
  }

  const located = await withPlatform((tx) =>
    tx.user.findFirst({ where: { email, deletedAt: null }, select: { id: true, tenantId: true } })
  );
  if (!located) throw new Error(`Учётная запись ${email} не найдена`);

  await withTenant(located.tenantId, (tx) =>
    tx.user.update({ where: { id: located.id }, data: { passwordHash } })
  );
  await prisma.session.updateMany({ where: { userId: located.id, revokedAt: null }, data: { revokedAt: now } });
  console.log(`Пароль изменён: ${email} — сотрудник мастерской. Все сессии погашены.`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
