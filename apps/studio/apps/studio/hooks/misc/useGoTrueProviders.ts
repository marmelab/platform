import { useEffect, useState } from 'react'
import { STUDIO_AUTH_GOTRUE } from '@/lib/constants'

interface GoTrueProviders {
  github: boolean
  sso: boolean
}

export function useGoTrueProviders(): GoTrueProviders {
  const [providers, setProviders] = useState<GoTrueProviders>({ github: false, sso: false })

  useEffect(() => {
    if (!STUDIO_AUTH_GOTRUE) return

    fetch('/api/self-hosted/gotrue-settings')
      .then((r) => r.json())
      .then((data) => {
        setProviders({
          github: Boolean(data?.external?.github?.enabled),
          sso: Boolean(data?.saml?.enabled),
        })
      })
      .catch(() => {})
  }, [])

  return providers
}
