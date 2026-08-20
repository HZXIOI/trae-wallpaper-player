import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'src/electron/main.ts',
        onstart: (options) => options.startup(),
        vite: {
          build: {
            sourcemap: true,
            minify: false,
            outDir: 'dist-electron/main',
            rollupOptions: {
              external: ['electron']
            }
          }
        }
      },
      {
        entry: 'src/electron/preload.ts',
        onstart: (options) => options.reload(),
        vite: {
          build: {
            sourcemap: true,
            minify: false,
            outDir: 'dist-electron/preload',
            rollupOptions: {
              external: ['electron']
            }
          }
        }
      }
    ]),
    renderer()
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
