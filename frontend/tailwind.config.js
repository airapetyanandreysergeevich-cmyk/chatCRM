/**
 * Тёмная тема FineCRM.
 * Акцент взят из логотипа — синий, а не фиолетовый: продукт должен быть заодно
 * со своим знаком, иначе интерфейс и логотип спорят друг с другом.
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0F1117",
        surface: { DEFAULT: "#171A22", raised: "#1E222C", input: "#141824" },
        line: { DEFAULT: "#262B37", strong: "#333A4A" },
        ink: { DEFAULT: "#E7EAF2", soft: "#B7BDCC", muted: "#8A90A2", dim: "#666C7D" },
        brand: { DEFAULT: "#2F8FE0", press: "#2278C6", tint: "#15283C", ink: "#8CC6F5" },
        state: {
          new: "#4C8DFF",
          waiting: "#E8A94B",
          progress: "#46B9CE",
          done: "#45C08A",
          off: "#E06B6B",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
      },
      borderRadius: { field: "12px", card: "14px", panel: "18px", pill: "999px" },
      boxShadow: {
        card: "0 1px 2px rgba(0,0,0,.35)",
        raised: "0 6px 20px rgba(0,0,0,.35)",
        modal: "0 24px 60px rgba(0,0,0,.55)",
      },
      transitionDuration: { 150: "150ms" },
    },
  },
  plugins: [],
};
