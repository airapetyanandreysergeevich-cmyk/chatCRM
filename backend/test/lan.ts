/**
 * Какой адрес Основы предлагать телефону: настоящая сеть мастерской, а не
 * Radmin VPN, Hamachi, WSL или VirtualBox.
 *
 *   npx tsx test/lan.ts
 */
import { lanScore } from "../src/lib/lan";
const cases: Array<[string, string]> = [
  ["Radmin VPN", "26.124.34.218"],
  ["Hamachi", "25.1.2.3"],
  ["Беспроводная сеть", "192.168.1.10"],
  ["Ethernet", "192.168.0.5"],
  ["vEthernet (WSL)", "172.28.80.1"],
  ["VirtualBox Host-Only Network", "192.168.56.1"],
  ["Wi-Fi", "10.0.0.7"],
  ["Tailscale", "100.101.1.1"],
  ["Подключение по локальной сети", "192.168.88.20"],
];
let bad = 0;
const ok = (n: string, c: boolean) => { console.log((c ? "ok     " : "ПЛОХО  ") + n); if (!c) bad++; };
const s = Object.fromEntries(cases.map(([n, a]) => [n, lanScore(n, a)]));
ok("Radmin 26.x не предлагается", s["Radmin VPN"] === null);
ok("Hamachi 25.x не предлагается", s["Hamachi"] === null);
ok("Tailscale 100.x не предлагается", s["Tailscale"] === null);
ok("Wi-Fi впереди WSL", s["Беспроводная сеть"]! > s["vEthernet (WSL)"]!);
ok("Ethernet впереди VirtualBox", s["Ethernet"]! > s["VirtualBox Host-Only Network"]!);
ok("Wi-Fi 10.x впереди WSL 172.x", s["Wi-Fi"]! > s["vEthernet (WSL)"]!);
ok("русское имя карты — настоящая", s["Подключение по локальной сети"]! > 5);
process.exitCode = bad ? 1 : 0;
