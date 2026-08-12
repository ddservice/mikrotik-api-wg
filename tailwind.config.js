/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#6366f1',
          hover: '#4f46e5',
          light: '#e0e7ff',
        },
        sidebar: {
          bg: '#0f172a',
          active: '#1e293b',
          border: '#334155',
        },
        card: {
          bg: '#ffffff',
          darkBg: '#1e293b',
        }
      },
    },
  },
  plugins: [],
};
