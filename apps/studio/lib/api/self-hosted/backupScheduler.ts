import { runScheduledBackups } from './backupManager'

let started = false

export function initBackupScheduler(): void {
  if (started) return
  started = true
  // Check immediately, then every hour
  runScheduledBackups().catch(() => {})
  setInterval(() => runScheduledBackups().catch(() => {}), 60 * 60 * 1000)
}
