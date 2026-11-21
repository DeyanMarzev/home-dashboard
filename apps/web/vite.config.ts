import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    // Installable app + our own service worker (docs/09 §1). Off in `vite dev`.
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src/sw',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false, // registered from main.tsx (UpdateToast)
      // Sends the Access cookie with the manifest request; without it Chrome gets the login
      // redirect and won't offer to install.
      useCredentials: true,
      includeAssets: ['icons/*'],
      manifest: {
        name: 'Home Dashboard',
        short_name: 'Home',
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#F3F4F1',
        theme_color: '#F3F4F1',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      injectManifest: {
        // The app shell: code, styles, the Latin font files and the icons. Never /api.
        globPatterns: ['**/*.{js,css,html,webmanifest}', 'icons/*', 'assets/*latin*.woff2'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
    }),
  ],
  resolve: {
    // Bundle the shared package from source, so a web build never picks up a stale dist/.
    alias: {
      '@home/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // In dev the API runs separately; in production it serves this build itself.
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 900 },
});
