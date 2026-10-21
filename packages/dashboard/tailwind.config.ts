import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Stark Editorial Minimalism — warm paper, deep ink. Nothing else.
        paper: '#FAF9F5',
        ink: { DEFAULT: '#111111', muted: '#6B6B6B' },
      },
      fontFamily: {
        serif: ['var(--font-serif)', 'Georgia', 'serif'],
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
      },
      // kept for the live tracker at /tracker — the editorial pages use no motion
      animation: { pulseGlow: 'pulseGlow 1.2s ease-in-out infinite' },
      keyframes: {
        pulseGlow: {
          '0%, 100%': { boxShadow: '0 0 6px 1px rgba(239, 68, 68, 0.9)' },
          '50%': { boxShadow: '0 0 18px 4px rgba(239, 68, 68, 0.65)' },
        },
      },
    },
  },
  plugins: [],
}

export default config
