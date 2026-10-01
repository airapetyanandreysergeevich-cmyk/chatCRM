/**
 * Цвета живут в CSS-переменных, а не в этом файле.
 *
 * Значения задаёт lib/theme.ts: он вычисляет их из семи цветов, которые
 * настроил владелец мастерской, и кладёт инлайном на <html>. Здесь остаются
 * только имена — чтобы `bg-surface/40` и `text-stage-done` продолжали
 * работать как обычные классы Tailwind.
 *
 * Каналы хранятся через пробел («15 17 23») именно ради <alpha-value>:
 * с обычным hex модификаторы прозрачности у переменных не работают.
 */
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: v("bg"),
        surface: {
          DEFAULT: v("surface"),
          raised: v("surface-raised"),
          hover: v("surface-hover"),
          input: v("surface-input"),
        },
        line: { DEFAULT: v("line"), strong: v("line-strong") },
        ink: {
          DEFAULT: v("ink"),
          soft: v("ink-soft"),
          muted: v("ink-muted"),
          dim: v("ink-dim"),
        },
        brand: {
          DEFAULT: v("brand"),
          press: v("brand-press"),
          tint: v("brand-tint"),
          ink: v("brand-ink"),
        },
        /** Четыре стадии заказа — единственный цвет, который видит клиент мастерской. */
        stage: {
          new: v("stage-new"),
          waiting: v("stage-waiting"),
          progress: v("stage-progress"),
          done: v("stage-done"),
        },
        /** Язык интерфейса: просрочено, срочно, оплачено. Не настраивается. */
        state: {
          new: v("state-new"),
          waiting: v("state-waiting"),
          progress: v("state-progress"),
          done: v("state-done"),
          off: v("state-off"),
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
      },
      borderRadius: { field: "12px", card: "14px", panel: "18px", pill: "999px" },
      boxShadow: {
        card: "0 1px 2px rgb(0 0 0 / .2)",
        raised: "0 6px 20px rgb(0 0 0 / .22)",
        modal: "0 24px 60px rgb(0 0 0 / .38)",
      },
      transitionDuration: { 150: "150ms" },
    },
  },
  plugins: [],
};
