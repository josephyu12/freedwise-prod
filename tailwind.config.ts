import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        surface: 'var(--surface)',
        'surface-hover': 'var(--surface-hover)',
        brand: {
          DEFAULT: 'var(--brand)',
          light: 'var(--brand-light)',
          lighter: 'var(--brand-lighter)',
          surface: 'var(--brand-surface)',
          dark: 'var(--brand-dark)',
        },
        border: 'var(--border)',
        'border-hover': 'var(--border-hover)',
      },
      borderRadius: {
        'card': 'var(--radius-xl)',
      },
      boxShadow: {
        'card': 'var(--shadow-md)',
        'card-hover': 'var(--shadow-lg)',
        'glow': 'var(--shadow-glow)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
export default config
