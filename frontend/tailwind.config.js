/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        conductor: {
          bg: '#0a0a0f',
          surface: '#12121a',
          card: '#1a1a2e',
          border: '#2a2a3e',
          accent: '#6366f1',
          'accent-light': '#818cf8',
          success: '#22c55e',
          warning: '#f59e0b',
          error: '#ef4444',
          muted: '#64748b',
        }
      },
      animation: {
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'flow-line': 'flow-line 1.5s ease-in-out infinite',
        'spin-slow': 'spin 8s linear infinite',
        'fade-in': 'fade-in 0.3s ease-out',
        'slide-up': 'slide-up 0.4s ease-out',
        'blink-error': 'blink-error 1s ease-in-out infinite',
      },
      keyframes: {
        'pulse-glow': {
          '0%, 100%': { boxShadow: '0 0 8px rgba(99, 102, 241, 0.3)' },
          '50%': { boxShadow: '0 0 24px rgba(99, 102, 241, 0.6)' },
        },
        'flow-line': {
          '0%': { strokeDashoffset: '20' },
          '100%': { strokeDashoffset: '0' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'blink-error': {
          '0%, 100%': { borderColor: 'rgba(239, 68, 68, 0.3)' },
          '50%': { borderColor: 'rgba(239, 68, 68, 0.9)' },
        },
      },
    },
  },
  plugins: [],
}
