/**
 * Дизайн-система перенесена с sunmarkets: Manrope, тёплый холст, статусные чипы «цвет + текст».
 * Отличие RepairShop — акцентный цвет: там синий #3559F5, здесь фиолетовый.
 * Чтобы сменить акцент, правьте только группу primary ниже.
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: "#5B45CC",
          press: "#4A36B0",
          tint: "#EAE5FB",
          ink: "#3A2A8C",
        },
        sun: { DEFAULT: "#FFC94D", ink: "#5B4210" },
        canvas: "#EFE7DA",
        surface: { DEFAULT: "#FFFFFF", muted: "#FAF6EF", field: "#FDFBF7" },
        line: { DEFAULT: "#EAE2D6", strong: "#E0D6C6", row: "#F2EDE4" },
        ink: { DEFAULT: "#1F2430", soft: "#3D4454", muted: "#6B7385", label: "#A08F76", ghost: "#A79C8C" },
        status: {
          new: "#3559F5",
          waiting: "#F0B75E",
          progress: "#5CC2D0",
          done: "#68C08D",
          cancelled: "#E38080",
        },
      },
      fontFamily: {
        sans: ["Manrope", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
      },
      borderRadius: { card: "16px", panel: "20px", field: "14px", pill: "999px" },
      boxShadow: {
        card: "0 2px 12px rgba(120,95,55,.06)",
        raised: "0 4px 14px rgba(120,95,55,.07)",
        modal: "0 20px 50px rgba(60,45,20,.25)",
      },
      minHeight: {
        // мастера работают с телефона, часто в перчатках
        touch: "56px",
      },
    },
  },
  plugins: [],
};
