import * as Sentry from '@sentry/nextjs'

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config')
    const { initLicense } = await import('./lib/api/self-hosted/licenseManager')
    const { startHealthPoller } = await import('./lib/api/self-hosted/healthPoller')
    initLicense()
    startHealthPoller()
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config')
  }
}

export const onRequestError = Sentry.captureRequestError
