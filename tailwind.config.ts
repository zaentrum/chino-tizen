import type { Config } from 'tailwindcss';

// Canonical Chino palette (shared with chino-web). Font sizing is scaled up at
// the root (see index.css) for 10-foot couch viewing, so the same utilities
// render larger here than on the web.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0D1117',
        surface: '#161B22',
        'surface-2': '#1C2128',
        border: '#21262D',
        'border-2': '#30363D',
        text: '#C9D1D9',
        muted: '#8B949E',
        accent: '#58A6FF',
        'signal-green': '#2EA043',
        'signal-amber': '#F2B233',
      },
    },
  },
  plugins: [],
} satisfies Config;
