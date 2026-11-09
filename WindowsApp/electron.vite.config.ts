import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  // Empty prefix → include DEEPSEEK_API_KEY from WindowsApp/.env (not only VITE_*).
  const env = loadEnv(mode, process.cwd(), '')
  const deepseekKey = (
    env.DEEPSEEK_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    ''
  ).trim()

  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      define: {
        __DEEPSEEK_API_KEY__: JSON.stringify(deepseekKey)
      },
      build: {
        rollupOptions: {
          input: {
            index: resolve('src/main/index.ts')
          }
        }
      }
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      build: {
        rollupOptions: {
          input: {
            index: resolve('src/preload/index.ts')
          }
        }
      }
    },
    renderer: {
      root: resolve('src/renderer'),
      build: {
        rollupOptions: {
          input: {
            index: resolve('src/renderer/index.html')
          }
        }
      },
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src')
        }
      },
      plugins: [react()]
    }
  }
})
