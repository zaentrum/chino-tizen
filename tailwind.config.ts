import type { Config } from 'tailwindcss';

// Canonical @nalet/design-system palette (shared with chino-web). Font sizing is
// scaled up at the root (see index.css) for 10-foot couch viewing, so the same
// utilities render larger here than on the web. SQUARE shape: all radii = 0.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0B0F19',
        'bg-2': '#0D1117',
        surface: '#11161F',
        'surface-2': '#161B26',
        border: '#1F2633',
        'border-2': '#2A3142',
        fg: '#E6E6E6',
        text: '#C9D1D9',
        'fg-2': '#C9D1D9',
        muted: '#AEB8C2',
        'fg-muted': '#AEB8C2',
        dim: '#6E7787',
        'fg-dim': '#6E7787',
        accent: '#58A6FF',
        'cloud-blue': '#58A6FF',
        cyan: '#00A4DC',
        'cloud-cyan': '#00A4DC',
        green: '#2EA043',
        'signal-green': '#2EA043',
        amber: '#F2B233',
        'signal-amber': '#F2B233',
        red: '#F85149',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        none: '0',
        sm: '0',
        DEFAULT: '0',
        md: '0',
        lg: '0',
        xl: '0',
        '2xl': '0',
        '3xl': '0',
        full: '0',
      },
    },
  },
  plugins: [],
} satisfies Config;
