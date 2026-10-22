import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath } from 'node:url';

const stub = fileURLToPath(new URL('./src/stubs/empty.js', import.meta.url));

// https://vitejs.dev/config/
export default defineConfig({
  base: './', // Crucial for file:// protocol resolution
  plugins: [
    react(),
    tailwindcss(),
    viteSingleFile()
  ],
  resolve: {
    // jsPDF lazy-loads these only for .html()/SVG helpers, which DocStudio never calls
    // (PDF export is our own text renderer). Stubbing them keeps the single file small.
    alias: {
      canvg: stub,
      dompurify: stub,
      html2canvas: stub
    }
  },
  server: {
    port: 5173,
    host: true
  }
});
