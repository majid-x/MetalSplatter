import { readFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { app } from 'electron'

function applyEnvFile(file: string): boolean {
  if (!existsSync(file)) return false
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
    return true
  } catch {
    return false
  }
}

/**
 * Load KEY=VALUE pairs into process.env (does not override non-empty existing vars).
 * Order: next to the executable (installed apps) → userData → project / asar paths (dev).
 */
export function loadEnvFile(): void {
  const candidates: string[] = []
  try {
    candidates.push(join(dirname(process.execPath), '.env'))
    candidates.push(join(app.getPath('userData'), '.env'))
    candidates.push(join(app.getAppPath(), '.env'))
  } catch {
    // app may not be ready in some test contexts
  }
  candidates.push(join(process.cwd(), '.env'))
  candidates.push(join(__dirname, '../../.env'))

  for (const file of candidates) {
    if (applyEnvFile(file)) return
  }
}
