/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // BOS — Agentic OS theme. Palette extracted from Kane's Start-at-the-Top
        // slides (Jun 11): near-black navy depths, electric violet accent
        // spectrum (#5b0bff->#d212ff), gold energy highlight. Utility names
        // preserved so all components pick up the look without edits.
        surface: {
          DEFAULT: '#05060f',
          1: '#0b0e1d',
          2: '#11152e',
          3: '#181d3a',
          4: '#232a4d',
        },
        base:   '#05060f',
        null:   '#0b0e1d',

        border: {
          DEFAULT: '#232a4d',
          strong:  '#3b4480',
        },
        text: {
          primary:   '#f1f4ff',
          secondary: '#aab3d6',
          muted:     '#7681a8',
        },

        // Aurora accent palette — one hue per agent / semantic role.
        v: {
          purple: '#8b5cf6',
          pink:   '#d946ef',
          green:  '#22c55e',
          blue:   '#4f6df5',
          amber:  '#f5c542',
        },

        // Primary accent — BOS electric violet. `bg-accent`, `text-accent`, etc.
        accent: {
          DEFAULT: '#8b5cf6',
          hover:   '#7c3aed',
          muted:   '#8b5cf61f',
        },

        success: {
          DEFAULT: '#20b26b',
          muted:   '#20b26b1a',
        },
        warning: {
          DEFAULT: '#f5c542',
          muted:   '#f59e0b1a',
        },
        danger: {
          DEFAULT: '#e84a6a',
          muted:   '#e11d481a',
        },
        info: {
          DEFAULT: '#38bdf8',
          muted:   '#0ea5e91a',
        },
      },
      fontFamily: {
        sans: [
          'Space Grotesk',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'sans-serif',
        ],
        mono: [
          'JetBrains Mono',
          'ui-monospace',
          'Fira Code',
          'Consolas',
          'monospace',
        ],
      },
      backgroundImage: {
        'ir-base': 'linear-gradient(135deg, #5bc3dc 0%, #8ddff0 48%, #dff8fd 100%)',
        'grad-cool': 'linear-gradient(135deg, #0ea5e9 0%, #20b26b 100%)',
        'grad-warm': 'linear-gradient(135deg, #ff4d8d 0%, #ff8a3d 100%)',
        'grad-lime': 'linear-gradient(135deg, #ffd43b 0%, #20b26b 100%)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fadeIn 0.2s ease-out',
        'slide-in': 'slideIn 0.2s ease-out',
      },
      keyframes: {
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        slideIn: {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};
