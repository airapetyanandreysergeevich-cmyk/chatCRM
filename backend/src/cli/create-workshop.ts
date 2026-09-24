/**
 * Первая мастерская в локальной установке.
 *
 *   node dist/cli/create-workshop.js "Сервис на Ленина" "Андрей Лапин" owner@local
 *
 * Пароль читается со стандартного ввода, а не из аргументов: аргументы видны
 * в списке процессов и оседают в истории оболочки.
 *
 * В облаке мастерские заводятся по заявке, через кабинет собственника
 * платформы. В коробке заявок нет и собственника платформы тоже — мастерская
 * одна, и создаётся она при первом запуске программы.
 *
 * С ключом --demo после мастерской заводятся тестовые данные — галочка
 * «Заполнить базу тестовыми данными» на первом запуске программы. Убрать их
 * владелец может одной кнопкой, из полосы вверху экрана.
 *
 * Скрипт можно запускать сколько угодно раз: если мастерская уже есть, он
 * ничего не делает. Это важно — первый запуск программы повторяется после
 * каждого выключения питания, и он не должен плодить мастерские.
 */
import { prisma, withTenant } from "../lib/db";
import { seedDemo } from "../modules/demo/demo";
import { createTenant } from "../services/tenant";

/** Короткий код мастерской из названия: латиница, цифры и дефисы. */
function slugify(name: string): string {
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
    й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
    у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
    э: "e", ю: "yu", я: "ya",
  };
  const slug = name
    .toLowerCase()
    .split("")
    .map((ch) => map[ch] ?? ch)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "workshop";
}

async function readPasswordFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

async function main() {
  const args = process.argv.slice(2);
  const demo = args.includes("--demo");
  const [name, ownerFullName, ownerEmail] = args.filter((a) => a !== "--demo");
  if (!name || !ownerFullName || !ownerEmail) {
    throw new Error('Нужны три аргумента: "Название мастерской" "Имя владельца" email');
  }

  // Проверяем до чтения пароля: если мастерская есть, незачем и спрашивать.
  const existing = await prisma.tenant.findFirst({ select: { id: true, name: true } });
  if (existing) {
    console.log(`Мастерская уже есть: ${existing.name}. Ничего не меняю.`);
    return;
  }

  const password = await readPasswordFromStdin();
  if (password.length < 8) throw new Error("Пароль должен быть не короче 8 символов");

  const tenant = await createTenant({
    name: name.trim(),
    slug: slugify(name),
    ownerEmail: ownerEmail.toLowerCase().trim(),
    ownerFullName: ownerFullName.trim(),
    ownerPassword: password,
  });

  console.log(`Создана мастерская «${tenant.name}» (${tenant.slug}), владелец ${ownerEmail}.`);

  if (demo) {
    // Отдельной транзакцией и без права провалить установку: мастерская уже
    // есть, и если тестовые данные не завелись, ими можно заполнить базу
    // позже — кнопкой в «Базах».
    try {
      const state = await withTenant(
        tenant.id,
        async (tx) => {
          const owner = await tx.user.findFirst({ where: { isOwner: true }, select: { id: true } });
          const full = await tx.tenant.findUnique({ where: { id: tenant.id }, select: { slug: true, maxUsers: true } });
          if (!owner || !full) throw new Error("не нашёлся владелец");
          return seedDemo(tx, tenant.id, { ownerId: owner.id, loginDomain: "", slug: full.slug, maxUsers: full.maxUsers });
        },
        { timeout: 2 * 60_000, maxWait: 30_000 }
      );
      console.log(`Тестовые данные: ${state.orders.length} заказов, ${state.customers.length} клиентов, ${state.users.length} сотрудников.`);
    } catch (err) {
      console.error("Тестовые данные не завелись:", err instanceof Error ? err.message : err);
    }
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
