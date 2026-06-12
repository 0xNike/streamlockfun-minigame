/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  // Preflight off so Tailwind's global reset can't disturb the existing
  // hand-written game CSS in styles.css. Utilities are still available.
  corePlugins: { preflight: false },
  theme: { extend: {} },
  plugins: [],
};
