// A stopped app (stop_app) keeps a readable database: the control plane reports it ACTIVE_HEALTHY, so that Studio
// still runs its queries, with platform_status "stopped". Shared by the banner (client) and the query route (server).

/** Postgres SQLSTATE read_only_sql_transaction: a write on a stopped app's read-only database. */
export const READ_ONLY_SQLSTATE = '25006'

export function isStopped(project?: object | null) {
  return (project as { platform_status?: string } | null | undefined)?.platform_status === 'stopped'
}

export function stoppedWriteMessage(name: string, message: string) {
  return `${name} is stopped, so Studio is read-only: start the app again to make changes (${message})`
}
