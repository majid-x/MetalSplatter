import { app } from 'electron'
import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { AUTH_STORAGE_CHANNELS } from '../shared/authStorageChannels'
import { handle } from './ipc'

function authDir(): string {
  return join(app.getPath('userData'), 'AuthSession')
}

function filePathFor(key: string): string {
  const safe = key.replace(/[/:]/g, '_')
  return join(authDir(), `${safe}.session`)
}

async function ensureDir(): Promise<void> {
  await mkdir(authDir(), { recursive: true })
}

export function registerAuthStorageIpc(): void {
  handle(AUTH_STORAGE_CHANNELS.get, async (_event, key: string) => {
    try {
      return await readFile(filePathFor(key), 'utf8')
    } catch {
      return null
    }
  })

  handle(AUTH_STORAGE_CHANNELS.set, async (_event, key: string, value: string) => {
    await ensureDir()
    await writeFile(filePathFor(key), value, 'utf8')
  })

  handle(AUTH_STORAGE_CHANNELS.remove, async (_event, key: string) => {
    try {
      await unlink(filePathFor(key))
    } catch {
      // already gone
    }
  })
}
