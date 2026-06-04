const path = require('node:path');

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'src/**/*.{ts,tsx}'),
  ],
  theme: {
    container: {
      center: true,
      padding: '1rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      // Design tokens — see docs/design/SYSTEM.md.
      // The `<alpha-value>` substitution lets utilities like `bg-accent/20`
      // generate the right color with transparency.
      colors: {
        // Surface ladder — bg-canvas / bg-chrome / bg-surface / bg-elevated / bg-overlay
        canvas: 'hsl(var(--bg-canvas) / <alpha-value>)',
        chrome: 'hsl(var(--bg-chrome) / <alpha-value>)',
        surface: 'hsl(var(--bg-surface) / <alpha-value>)',
        elevated: 'hsl(var(--bg-elevated) / <alpha-value>)',
        overlay: 'hsl(var(--bg-overlay) / <alpha-value>)',
        // Foregrounds — text-fg / text-fg-body / text-fg-muted / text-fg-disabled
        fg: {
          DEFAULT: 'hsl(var(--fg-primary) / <alpha-value>)',
          body: 'hsl(var(--fg-body) / <alpha-value>)',
          muted: 'hsl(var(--fg-muted) / <alpha-value>)',
          disabled: 'hsl(var(--fg-disabled) / <alpha-value>)',
        },
        // Accent (signal green)
        accent: {
          DEFAULT: 'hsl(var(--accent) / <alpha-value>)',
          hover: 'hsl(var(--accent-hover) / <alpha-value>)',
          active: 'hsl(var(--accent-active) / <alpha-value>)',
          soft: 'hsl(var(--accent-soft) / <alpha-value>)',
          fg: 'hsl(var(--accent-fg) / <alpha-value>)',
        },
        // Switch off-track token
        'switch-off': 'hsl(var(--switch-off) / <alpha-value>)',
        // Status
        success: 'hsl(var(--success) / <alpha-value>)',
        warning: 'hsl(var(--warning) / <alpha-value>)',
        destructive: 'hsl(var(--destructive) / <alpha-value>)',
        info: 'hsl(var(--info) / <alpha-value>)',
      },
      borderColor: {
        // `.border` (no color) → border-default
        DEFAULT: 'hsl(var(--border-default) / <alpha-value>)',
        subtle: 'hsl(var(--border-subtle) / <alpha-value>)',
        emphasis: 'hsl(var(--border-emphasis) / <alpha-value>)',
      },
      ringColor: {
        DEFAULT: 'hsl(var(--accent) / <alpha-value>)',
      },
      ringOffsetColor: {
        DEFAULT: 'hsl(var(--bg-canvas) / <alpha-value>)',
      },
      fontFamily: {
        sans: [
          'IBM Plex Sans',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'sans-serif',
        ],
        mono: [
          'IBM Plex Mono',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'monospace',
        ],
      },
      fontSize: {
        // Locked-in scale — see SYSTEM.md §3.
        caption: ['11px', { lineHeight: '16px', letterSpacing: '0.08em' }],
        'body-sm': ['12px', { lineHeight: '18px' }],
        body: ['13px', { lineHeight: '20px' }],
        'body-lg': ['14px', { lineHeight: '22px' }],
        'heading-sm': ['16px', { lineHeight: '22px', fontWeight: '600' }],
        heading: ['20px', { lineHeight: '28px', fontWeight: '600' }],
        'heading-lg': ['28px', { lineHeight: '34px', fontWeight: '600' }],
        display: [
          '40px',
          { lineHeight: '44px', fontWeight: '700', letterSpacing: '-0.02em' },
        ],
      },
      borderRadius: {
        none: '0',
        sm: '4px',
        DEFAULT: '6px',
        md: '8px',
        lg: '12px',
        full: '9999px',
      },
      boxShadow: {
        modal: '0 16px 48px -16px rgb(0 0 0 / 0.7)',
        popover: '0 8px 32px -8px rgb(0 0 0 / 0.55)',
      },
      keyframes: {
        // Sonner toast / dialog transitions kept extremely short per SYSTEM.md §7.
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'fade-out': { from: { opacity: '1' }, to: { opacity: '0' } },
      },
      animation: {
        'fade-in': 'fade-in 150ms ease-out',
        'fade-out': 'fade-out 100ms ease-in',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
