import { ShieldOff } from 'lucide-react'
import { Alert_Shadcn_, AlertDescription_Shadcn_, AlertTitle_Shadcn_ } from 'ui'
import type { LicenseTier } from '@/lib/api/self-hosted/licenseManager'

interface ProUpgradePromptProps {
  featureName: string
  requiredTier?: LicenseTier
}

const TIER_LABEL: Record<string, string> = {
  business: 'Business',
  enterprise: 'Enterprise',
}

export function ProUpgradePrompt({ featureName, requiredTier = 'business' }: ProUpgradePromptProps) {
  const label = TIER_LABEL[requiredTier] ?? 'Business'
  return (
    <Alert_Shadcn_ variant="default" className="border-warning/40 bg-warning-200">
      <ShieldOff className="h-4 w-4 text-warning-600" />
      <AlertTitle_Shadcn_ className="text-warning-700">{label} feature</AlertTitle_Shadcn_>
      <AlertDescription_Shadcn_ className="text-warning-600">
        {featureName} requires a {label} license. Set{' '}
        <code className="text-xs">MULTI_HEAD_LICENSE_KEY</code> in your{' '}
        <code className="text-xs">.env</code>, or remove{' '}
        <code className="text-xs">MULTI_HEAD_LICENSE_SERVER_URL</code> to run fully self-hosted
        ({label} unlocked automatically).
      </AlertDescription_Shadcn_>
    </Alert_Shadcn_>
  )
}
