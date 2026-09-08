import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: {
      '/bridge': { target: 'http://127.0.0.1:5174', ws: true },
      '^/asset(?:\\?|$)': { target: 'http://127.0.0.1:5174' }
    }
  },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    // These notices must remain in dist when redundant node_modules are excluded
    // from the desktop package. Vite collects licenses of bundled dependencies.
    license: { fileName: 'third-party-licenses.txt' },
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'three', test: /[\\/]node_modules[\\/]three[\\/]/, priority: 20 },
            { name: 'react', test: /[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/, priority: 10 }
          ]
        }
      }
    }
  }
});
