import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const KEY_LEN = 64;

/** scrypt из стандартной библиотеки Node — без нативных зависимостей и проблем сборки на alpine. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const key = (await scryptAsync(plain, salt, KEY_LEN)) as Buffer;
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const key = (await scryptAsync(plain, Buffer.from(saltHex, "hex"), KEY_LEN)) as Buffer;
  const expected = Buffer.from(keyHex, "hex");
  return key.length === expected.length && timingSafeEqual(key, expected);
}
