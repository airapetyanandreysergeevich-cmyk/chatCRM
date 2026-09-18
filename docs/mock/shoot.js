const { chromium } = require("/tmp/claude-0/-home-claude/ccf341fd-258f-525b-92e1-8f8e6b6d6aae/scratchpad/node_modules/playwright-core");
const path = require("path");

const OUT = "/tmp/claude-0/-home-claude/ccf341fd-258f-525b-92e1-8f8e6b6d6aae/scratchpad/shots";
const BASE = "http://127.0.0.1:4100";

(async () => {
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--no-sandbox", "--font-render-hinting=none"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 800 }, deviceScaleFactor: 2, locale: "ru-RU" });
  const page = await ctx.newPage();
  const shot = async (name, opts = {}) => {
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(OUT, name + ".png"), ...opts });
    console.log("снято:", name);
  };

  await page.request.post(BASE + "/api/demo/reset");
  await page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await shot("site-login");

  // Плитка iOS с инструкцией
  const ios = page.getByText("Как установить", { exact: false }).first();
  if (await ios.count()) {
    await ios.click();
    await page.waitForTimeout(500);
    await page.locator('[role="dialog"]').screenshot({ path: OUT + "/site-ios.png" });
    console.log("снято: site-ios");
  }
  await page.goto(BASE + "/login", { waitUntil: "networkidle" });

  console.log("перед входом:", page.url(), await page.locator('input[type="password"]').count());
  await page.fill('input[type="email"]', "vladelec@remont.local").catch((e) => console.log("email:", e.message.slice(0, 80)));
  await page.fill('input[type="password"]', "demo12345");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState("networkidle");
  await shot("site-dashboard");

  await page.setViewportSize({ width: 1360, height: 700 });
  await page.goto(BASE + "/staff", { waitUntil: "networkidle" });
  await shot("site-staff");

  const add = page.getByRole("button", { name: /Добавить сотрудника/ }).first();
  if (await add.count()) {
    await add.click();
    await page.waitForTimeout(500);
    await page.locator('[role="dialog"]').screenshot({ path: OUT + "/site-staff-new.png" });
    console.log("снято: site-staff-new");
  }

  await page.goto(BASE + "/staff", { waitUntil: "networkidle" });
  const pwd = page.getByRole("button", { name: "Пароль", exact: true }).nth(2);
  if (await pwd.count()) {
    await pwd.click();
    await page.waitForTimeout(500);
    await page.locator('[role="dialog"]').screenshot({ path: OUT + "/site-staff-password.png" });
    console.log("снято: site-staff-password");
  }

  await page.setViewportSize({ width: 1360, height: 640 });
  await page.goto(BASE + "/settings", { waitUntil: "networkidle" });
  await shot("site-settings");

  await page.goto(BASE + "/settings/feedback", { waitUntil: "networkidle" });
  await shot("site-feedback", { fullPage: true });

  await browser.close();
})().catch((e) => {
  console.error("сорвалось:", e.message);
  process.exit(1);
});
