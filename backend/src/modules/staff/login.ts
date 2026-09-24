import { z } from "zod";
import { localProblem } from "../../lib/login";

/**
 * Логин сотрудника — одно правило для формы и для загрузки из файла.
 *
 * У мастерской с именем (lenina) логины одного вида — nikita@lenina, и
 * владелец вводит только часть до @: окончание дописывается здесь. Чужое
 * окончание не принимаем — такой логин не заработал бы на общем сайте, и
 * узнали бы об этом не здесь, а у стойки в понедельник утром.
 * У мастерской без имени логин — только настоящая почта: логин вида
 * nikita@lenina в облаке ушёл бы искать мастерскую lenina.
 */
export function loginFor(raw: string, domain: string): { ok: true; login: string } | { ok: false; reason: string } {
  const login = String(raw ?? "").trim().toLowerCase();
  if (!login) return { ok: false, reason: "Укажите логин" };
  if (domain) {
    const at = login.lastIndexOf("@");
    const local = at >= 0 ? login.slice(0, at) : login;
    const tail = at >= 0 ? login.slice(at + 1) : domain;
    if (tail !== domain) return { ok: false, reason: `Логин в этой мастерской оканчивается на @${domain}` };
    const bad = localProblem(local);
    if (bad) return { ok: false, reason: bad };
    return { ok: true, login: `${local}@${domain}` };
  }
  if (!z.string().email().safeParse(login).success) return { ok: false, reason: "Похоже, это не email" };
  return { ok: true, login };
}
