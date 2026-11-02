import { ipcMain, type IpcMainInvokeEvent } from 'electron'

/** Register (or replace) an invoke handler — safe across electron-vite main HMR. */
export function handle(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown | Promise<unknown>
): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, listener)
}
