/**
 * Локальная разработка: создать собственника платформы вручную.
 * На сервере этого делать не нужно — приложение создаёт его само при первом старте
 * (см. src/services/bootstrap.ts), потому что в собранный образ исходники не попадают.
 *
 *   PLATFORM_OWNER_EMAIL=... PLATFORM_OWNER_PASSWORD=... npm run seed
 */
import { prisma } from "../src/lib/db";
import { ensurePlatformOwner } from "../src/services/bootstrap";

ensurePlatformOwner()
  .then(() => console.log("Готово"))
  .finally(() => prisma.$disconnect());
