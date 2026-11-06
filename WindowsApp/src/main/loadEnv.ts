import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

/** Load KEY=VALUE pairs from WindowsApp/.env into process.env (does not override existing). */
export function loadEnvFile(): void {
  const candidates = [
    join(app.getAppPath(), '.env'),
    join(process.cwd(), '.env'),
    join(__dirname, '../../.env')
  ]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      const text = readFileSync(file, 'utf8')
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) continue
        const eq = line.indexOf('=')
        if (eq <= 0) continue
        const key = line.slice(0, eq).trim()
        let value = line.slice(eq + 1).trim()
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1)
        }
        if (!(key in process.env) || process.env[key] === '') {
          process.env[key] = value
        }
      }
      return
    } catch {
      // try next path
    }
  }
}
