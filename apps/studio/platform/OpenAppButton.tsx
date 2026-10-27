import { ExternalLink } from 'lucide-react'
import { Button } from 'ui'

import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'

/** Opens the running app (public_url, served by the control plane) in a new tab. */
export const OpenAppButton = () => {
  const { data: project } = useSelectedProjectQuery()
  const url = (project as { public_url?: string } | undefined)?.public_url
  if (!url) return null

  return (
    <Button type="default" className="rounded-full" icon={<ExternalLink />} asChild>
      <a href={url} target="_blank" rel="noreferrer noopener">
        Open app
      </a>
    </Button>
  )
}
