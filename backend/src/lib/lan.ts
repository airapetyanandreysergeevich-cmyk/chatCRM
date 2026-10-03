import { networkInterfaces } from "node:os";

/**
 * Адреса этого компьютера в сети мастерской — лучший первым.
 *
 * Первый попавшийся адрес часто не тот: у Windows рядом с Wi-Fi и Ethernet
 * живут Radmin VPN (26.x), Hamachi (25.x), VirtualBox (192.168.56.x),
 * vEthernet от WSL и Hyper-V. По такому адресу телефон в Wi-Fi мастерской
 * не достучится. Поэтому:
 * - берём только частные сети (10.x, 172.16–31.x, 192.168.x): VPN-адреса вроде
 *   26.x и 25.x — не частные, в Wi-Fi до них не дойти;
 * - виртуальные и VPN-карты — в конец списка;
 * - «Wi-Fi» и «Ethernet» — вперёд.
 */
export function lanAddresses(): string[] {
  const found: Array<{ address: string; score: number }> = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family !== "IPv4" || net.internal) continue;
      const score = lanScore(name, net.address);
      if (score !== null) found.push({ address: net.address, score });
    }
  }
  return found.sort((a, b) => b.score - a.score).map((f) => f.address);
}

const VIRTUAL =
  /virtual|vbox|vmware|vethernet|hyper-?v|wsl|docker|radmin|hamachi|zerotier|tailscale|wireguard|openvpn|vpn|tap|tun|loopback|bluetooth|npcap/i;
const REAL = /^(ethernet|wi-?fi|wlan|eth\d|en\d|wl|беспровод|подключение по локальной|сетевое подключение)/i;

/** null — адрес телефону не годится вовсе; иначе чем больше, тем вероятнее это сеть мастерской. */
export function lanScore(name: string, address: string): number | null {
  const p = address.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  const [a, b, c] = p;
  if (a === 169 && b === 254) return null;
  const isPrivate = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  if (!isPrivate) return null;

  let score = a === 192 ? 3 : a === 10 ? 2 : 1;
  if (REAL.test(name)) score += 10;
  if (VIRTUAL.test(name)) score -= 50;
  if (a === 192 && b === 168 && c === 56) score -= 40; // сеть VirtualBox по умолчанию
  return score;
}
