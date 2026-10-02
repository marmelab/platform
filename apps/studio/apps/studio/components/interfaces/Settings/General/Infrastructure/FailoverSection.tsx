import { formatDistanceToNow } from 'date-fns'
import { ShieldCheck, ShieldOff, Zap } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Card, CardContent } from 'ui'
import ConfirmationModal from 'ui-patterns/Dialogs/ConfirmationModal'
import {
  PageSection,
  PageSectionContent,
  PageSectionDescription,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from 'ui-patterns/PageSection'

import {
  useDeprovisionStandbyMutation,
  useFailoverMutation,
  useProvisionStandbyMutation,
} from '@/data/projects/project-standby-mutation'
import { useLicenseQuery } from '@/data/misc/license-query'
import { ProUpgradePrompt } from '@/components/interfaces/ProUpgradePrompt'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'

// Fields added by multi-head that are not in the upstream OpenAPI types
type FailoverProject = {
  ref: string
  role?: 'primary' | 'standby'
  standby_ref?: string
  failover_count?: number
  last_failover_at?: string
}

export function FailoverSection() {
  const { data: _project } = useSelectedProjectQuery()
  const project = _project as unknown as FailoverProject | undefined
  const { data: license } = useLicenseQuery()
  const isBusiness = license?.tier === 'business' || license?.tier === 'enterprise'

  const [confirmRemove, setConfirmRemove] = useState(false)
  const [confirmFailover, setConfirmFailover] = useState(false)

  const ref = project?.ref ?? ''
  const hasStandby = Boolean(project?.standby_ref)
  const failoverCount = project?.failover_count ?? 0
  const lastFailoverAt = project?.last_failover_at

  const { mutate: provision, isPending: isProvisioning } = useProvisionStandbyMutation({
    onSuccess: () => toast.success('Standby stack is provisioning — will be ready in ~30 seconds'),
    onError: (err) => toast.error(`Failed to provision standby: ${err.message}`),
  })

  const { mutate: deprovision, isPending: isDeprovisioning } = useDeprovisionStandbyMutation({
    onSuccess: () => {
      setConfirmRemove(false)
      toast.success('Failover standby removed')
    },
    onError: (err) => {
      setConfirmRemove(false)
      toast.error(`Failed to remove standby: ${err.message}`)
    },
  })

  const { mutate: failover, isPending: isFailingOver } = useFailoverMutation({
    onSuccess: () => {
      setConfirmFailover(false)
      toast.success('Failover complete — project is now running on the standby stack')
    },
    onError: (err) => {
      setConfirmFailover(false)
      toast.error(`Failover failed: ${err.message}`)
    },
  })

  if (!project) return null

  return (
    <>
      <PageSection id="failover">
        <PageSectionMeta>
          <PageSectionSummary>
            <PageSectionTitle>Failover protection</PageSectionTitle>
            <PageSectionDescription>
              A warm standby stack that Studio promotes automatically if this project becomes
              unavailable for ~90 seconds.
            </PageSectionDescription>
          </PageSectionSummary>
        </PageSectionMeta>

        <PageSectionContent>
          <Card>
            <CardContent>
              <div className="flex flex-col @lg:flex-row @lg:justify-between @lg:items-start gap-4">
                <div className="flex items-start gap-3">
                  {hasStandby ? (
                    <ShieldCheck className="mt-0.5 text-brand" size={18} strokeWidth={1.5} />
                  ) : (
                    <ShieldOff className="mt-0.5 text-foreground-muted" size={18} strokeWidth={1.5} />
                  )}
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm">Standby stack</p>
                      {hasStandby ? (
                        <Badge variant="default" className="text-xs">Active</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs">Not configured</Badge>
                      )}
                    </div>
                    <p className="text-sm text-foreground-light max-w-[420px]">
                      {hasStandby
                        ? 'A standby stack is running and ready to receive traffic. Studio will auto-promote it on 3 consecutive health-check failures.'
                        : 'No standby configured. Add one to enable automatic failover.'}
                    </p>
                    {failoverCount > 0 && (
                      <p className="text-xs text-foreground-muted">
                        Failed over {failoverCount} time{failoverCount !== 1 ? 's' : ''}
                        {lastFailoverAt
                          ? ` · last ${formatDistanceToNow(new Date(lastFailoverAt), { addSuffix: true })}`
                          : ''}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex gap-2 shrink-0">
                  {!isBusiness ? (
                    <ProUpgradePrompt featureName="Failover standby" requiredTier="business" />
                  ) : hasStandby ? (
                    <>
                      <Button
                        type="warning"
                        icon={<Zap size={14} />}
                        onClick={() => setConfirmFailover(true)}
                        loading={isFailingOver}
                        disabled={isFailingOver || isDeprovisioning}
                      >
                        Trigger failover
                      </Button>
                      <Button
                        type="default"
                        onClick={() => setConfirmRemove(true)}
                        loading={isDeprovisioning}
                        disabled={isDeprovisioning || isFailingOver}
                      >
                        Remove standby
                      </Button>
                    </>
                  ) : (
                    <Button
                      type="default"
                      icon={<ShieldCheck size={14} />}
                      onClick={() => provision({ ref })}
                      loading={isProvisioning}
                      disabled={isProvisioning}
                    >
                      {isProvisioning ? 'Provisioning...' : 'Add failover stack'}
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </PageSectionContent>
      </PageSection>

      <ConfirmationModal
        visible={confirmRemove}
        title="Remove failover standby?"
        confirmLabel="Remove standby"
        confirmLabelLoading="Removing..."
        loading={isDeprovisioning}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => deprovision({ ref })}
      >
        <p className="text-sm text-foreground-light">
          The standby stack will be stopped and deleted. Automatic failover will no longer be
          available for this project.
        </p>
      </ConfirmationModal>

      <ConfirmationModal
        variant="destructive"
        visible={confirmFailover}
        title="Trigger manual failover?"
        confirmLabel="Failover now"
        confirmLabelLoading="Failing over..."
        loading={isFailingOver}
        onCancel={() => setConfirmFailover(false)}
        onConfirm={() => failover({ ref })}
      >
        <p className="text-sm text-foreground-light">
          The project will switch to its standby stack immediately. The current primary stack will
          be shut down and a new standby provisioned in the background.
        </p>
        <p className="text-sm text-foreground-light mt-2">
          There will be a brief connection interruption while the handover completes.
        </p>
      </ConfirmationModal>
    </>
  )
}
