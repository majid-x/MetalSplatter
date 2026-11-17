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
  // Production/MSIX: damage off. Dev + `--mode damage` (Vroomk Test): on.
  const damageFromEnv = process.env.VROOMK_DAMAGE_ESTIMATION
  const damageEnabled =
    damageFromEnv === '1'
      ? true
      : damageFromEnv === '0'
        ? false
        : mode === 'damage' || mode === 'development'

  const featureDefines = {
    __DEEPSEEK_API_KEY__: JSON.stringify(deepseekKey),
    __VROOMK_DAMAGE_ESTIMATION__: JSON.stringify(damageEnabled)
  }

  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      define: featureDefines,
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
      define: {
        __VROOMK_DAMAGE_ESTIMATION__: JSON.stringify(damageEnabled)
      },
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
      define: {
        __VROOMK_DAMAGE_ESTIMATION__: JSON.stringify(damageEnabled)
      },
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
