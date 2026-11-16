/** @type {import('tailwindcss').Config} */
// Brand blue is drawn from the @Cloud logo cloud; accent amber from its "@".
// `blue` and `gray` are retuned (not just extended) so the hundreds of
// existing `bg-blue-600` / `text-gray-700` classes pick up the theme at once.
const brand = {
  50: "#F1F7FC",
  100: "#E2EEF8",
  200: "#C0DBF0",
  300: "#8FC0E4",
  400: "#5AA2D4",
  500: "#3586C0",
  600: "#236CA6",
  700: "#1D5787",
  800: "#1C4A70",
  900: "#1B3E5D",
  950: "#12283E",
};

// Warm neutral: slightly paper-toned so pages feel calmer than cool slate.
const neutral = {
  50: "#FAFAF8",
  100: "#F4F4F1",
  200: "#E7E6E1",
  300: "#D3D1CA",
  400: "#A3A19A",
  500: "#706E67",
  600: "#57554F",
  700: "#3F3D39",
  800: "#292825",
  900: "#1A1917",
  950: "#0F0E0D",
};

const accent = {
  50: "#FEF8EC",
  100: "#FCEDCB",
  200: "#F8D992",
  300: "#F2BF58",
  400: "#E9A23B",
  500: "#D4851F",
  600: "#B46517",
  700: "#8F4B17",
  800: "#753C19",
  900: "#623318",
};

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        brand,
        accent,
        blue: brand,
        gray: neutral,
        canvas: "#F6F5F1",
      },
      fontFamily: {
        sans: [
          '"Instrument Sans"',
          "system-ui",
          "Segoe UI",
          "Roboto",
          "Arial",
          "sans-serif",
        ],
        display: ['"Fraunces"', "Georgia", "Cambria", "serif"],
      },
      borderRadius: {
        lg: "0.625rem",
        xl: "0.875rem",
        "2xl": "1.125rem",
      },
      boxShadow: {
        sm: "0 1px 2px 0 rgb(26 25 23 / 0.05)",
        DEFAULT:
          "0 1px 2px 0 rgb(26 25 23 / 0.05), 0 1px 3px 0 rgb(26 25 23 / 0.05)",
        md: "0 1px 2px 0 rgb(26 25 23 / 0.04), 0 4px 14px -4px rgb(26 25 23 / 0.08)",
        lg: "0 2px 6px -1px rgb(26 25 23 / 0.05), 0 14px 32px -8px rgb(26 25 23 / 0.12)",
        xl: "0 4px 10px -2px rgb(26 25 23 / 0.06), 0 24px 48px -12px rgb(26 25 23 / 0.16)",
      },
      transitionTimingFunction: {
        "out-expo": "cubic-bezier(0.16, 1, 0.3, 1)",
      },
    },
  },
  plugins: [],
};
