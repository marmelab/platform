import { Lock } from 'lucide-react'
import { Alert_Shadcn_, AlertDescription_Shadcn_, AlertTitle_Shadcn_, cn } from 'ui'

import { isStopped } from './stopped'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'

export const StoppedBanner = () => {
  const { data: project } = useSelectedProjectQuery()
  if (!isStopped(project)) return null

  return (
    <Alert_Shadcn_
      variant="warning"
      className={cn('border-0 border-r-0 rounded-none [&>svg]:left-6 px-6 [&>svg]:w-[26px] [&>svg]:h-[26px]')}
    >
      <Lock />
      <AlertTitle_Shadcn_>{project?.name} is stopped</AlertTitle_Shadcn_>
      <AlertDescription_Shadcn_>
        Its tables can be browsed but not changed, and its files are unavailable, until an owner or an admin starts
        the app again.
      </AlertDescription_Shadcn_>
    </Alert_Shadcn_>
  )
}
