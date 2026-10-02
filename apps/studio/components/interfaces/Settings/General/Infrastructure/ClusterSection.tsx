import { formatDistanceToNow } from 'date-fns'
import { Database, Plus, Trash, Zap } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Card, CardContent, Input_Shadcn_ } from 'ui'
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
  useClusterFailoverMutation,
  useDeprovisionReplicaMutation,
  useProvisionReplicaMutation,
} from '@/data/projects/project-replica-mutation'
import { useLicenseQuery } from '@/data/misc/license-query'
import { ProUpgradePrompt } from '@/components/interfaces/ProUpgradePrompt'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'

// Fields added by multi-head that are not in the upstream OpenAPI types
type ClusterProject = {
  ref: string
  cluster_id?: string
  role?: 'primary' | 'standby' | 'replica'
  failover_count?: number
  last_failover_at?: string
}

type ReplicaEntry = {
  ref: string
  name: string
  status: string
  replica_rank: number
  docker_host?: string
}

export function ClusterSection() {
  const { data: _project } = useSelectedProjectQuery()
  const project = _project as unknown as (ClusterProject & { replicas?: ReplicaEntry[] }) | undefined

  const [confirmFailover, setConfirmFailover] = useState(false)
  const [removingRef, setRemovingRef] = useState<string | null>(null)
  const [addDockerHost, setAddDockerHost] = useState('')
  const [showAddForm, setShowAddForm] = useState(false)

  const { data: license } = useLicenseQuery()
  const isEnterprise = license?.tier === 'enterprise'

  const ref = project?.ref ?? ''
  const replicas: ReplicaEntry[] = (project as any)?.replicas ?? []
  const failoverCount = project?.failover_count ?? 0
  const lastFailoverAt = project?.last_failover_at

  const { mutate: provision, isPending: isProvisioning } = useProvisionReplicaMutation({
    onSuccess: () => {
      setShowAddForm(false)
      setAddDockerHost('')
      toast.success('Replica is provisioning — will be ready in ~30 seconds')
    },
    onError: (err) => toast.error(`Failed to provision replica: ${err.message}`),
  })

  const { mutate: deprovision, isPending: isDeprovisioning } = useDeprovisionReplicaMutation({
    onSuccess: () => {
      setRemovingRef(null)
      toast.success('Replica removed')
    },
    onError: (err) => {
      setRemovingRef(null)
      toast.error(`Failed to remove replica: ${err.message}`)
    },
  })

  const { mutate: failover, isPending: isFailingOver } = useClusterFailoverMutation({
    onSuccess: () => {
      setConfirmFailover(false)
      toast.success('Cluster failover complete — master promoted from replica')
    },
    onError: (err) => {
      setConfirmFailover(false)
      toast.error(`Cluster failover failed: ${err.message}`)
    },
  })

  if (!project?.cluster_id) return null

  const isBusy = isProvisioning || isDeprovisioning || isFailingOver

  return (
    <>
      <PageSection id="cluster">
        <PageSectionMeta>
          <PageSectionSummary>
            <PageSectionTitle>
              <span className="flex items-center gap-2">
                <Database size={16} strokeWidth={1.5} />
                Cluster
              </span>
            </PageSectionTitle>
            <PageSectionDescription>
              One writable master with read replicas. Studio automatically promotes the
              highest-priority healthy replica if the master becomes unavailable (~90 s).
            </PageSectionDescription>
          </PageSectionSummary>
        </PageSectionMeta>

        <PageSectionContent className="space-y-3">
          {/* Failover stats */}
          {failoverCount > 0 && (
            <p className="text-xs text-foreground-muted">
              Failed over {failoverCount} time{failoverCount !== 1 ? 's' : ''}
              {lastFailoverAt
                ? ` · last ${formatDistanceToNow(new Date(lastFailoverAt), { addSuffix: true })}`
                : ''}
            </p>
          )}

          {/* Replica list */}
          <Card>
            <CardContent className="p-0">
              {replicas.length === 0 ? (
                <p className="px-4 py-3 text-sm text-foreground-light">No replicas provisioned yet.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border-muted text-left text-xs text-foreground-muted">
                      <th className="px-4 py-2 font-medium">Rank</th>
                      <th className="px-4 py-2 font-medium">Name</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 font-medium">Docker host</th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {replicas
                      .slice()
                      .sort((a, b) => a.replica_rank - b.replica_rank)
                      .map((r) => (
                        <tr key={r.ref} className="border-b border-border-muted last:border-0">
                          <td className="px-4 py-2 tabular-nums text-foreground-light">{r.replica_rank}</td>
                          <td className="px-4 py-2">{r.name}</td>
                          <td className="px-4 py-2">
                            <Badge
                              variant={r.status === 'ACTIVE_HEALTHY' ? 'default' : 'secondary'}
                              className="text-xs"
                            >
                              {r.status === 'ACTIVE_HEALTHY' ? 'Healthy' : r.status}
                            </Badge>
                          </td>
                          <td className="px-4 py-2 text-foreground-light font-mono text-xs">
                            {r.docker_host ?? 'local'}
                          </td>
                          <td className="px-4 py-2 text-right">
                            <Button
                              type="text"
                              icon={<Trash size={14} />}
                              onClick={() => setRemovingRef(r.ref)}
                              disabled={isBusy || !isEnterprise}
                            />
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          {/* Add replica / failover controls */}
          {!isEnterprise ? (
            <ProUpgradePrompt featureName="Cluster mode" requiredTier="enterprise" />
          ) : showAddForm ? (
            <div className="flex items-center gap-2">
              <Input_Shadcn_
                className="h-8 text-sm font-mono"
                placeholder="Docker host (optional, e.g. ssh://user@host)"
                value={addDockerHost}
                onChange={(e) => setAddDockerHost(e.target.value)}
                disabled={isProvisioning}
              />
              <Button
                type="default"
                loading={isProvisioning}
                disabled={isProvisioning}
                onClick={() =>
                  provision({ ref, docker_host: addDockerHost.trim() || undefined })
                }
              >
                {isProvisioning ? 'Adding...' : 'Add'}
              </Button>
              <Button type="text" onClick={() => setShowAddForm(false)} disabled={isProvisioning}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button
                type="default"
                icon={<Plus size={14} />}
                onClick={() => setShowAddForm(true)}
                disabled={isBusy}
              >
                Add replica
              </Button>
              <Button
                type="warning"
                icon={<Zap size={14} />}
                onClick={() => setConfirmFailover(true)}
                disabled={isBusy || replicas.filter((r) => r.status === 'ACTIVE_HEALTHY').length === 0}
              >
                Trigger failover
              </Button>
            </div>
          )}
        </PageSectionContent>
      </PageSection>

      {/* Remove replica confirmation */}
      <ConfirmationModal
        visible={removingRef !== null}
        title="Remove replica?"
        confirmLabel="Remove"
        confirmLabelLoading="Removing..."
        loading={isDeprovisioning}
        onCancel={() => setRemovingRef(null)}
        onConfirm={() => {
          if (removingRef) deprovision({ ref, replicaRef: removingRef })
        }}
      >
        <p className="text-sm text-foreground-light">
          The replica stack will be stopped and deleted. It will no longer be available as a
          failover candidate.
        </p>
      </ConfirmationModal>

      {/* Cluster failover confirmation */}
      <ConfirmationModal
        variant="destructive"
        visible={confirmFailover}
        title="Trigger cluster failover?"
        confirmLabel="Failover now"
        confirmLabelLoading="Failing over..."
        loading={isFailingOver}
        onCancel={() => setConfirmFailover(false)}
        onConfirm={() => failover({ ref })}
      >
        <p className="text-sm text-foreground-light">
          The master will switch to its highest-priority healthy replica immediately. The current
          master stack will be shut down and a new replica provisioned in the background.
        </p>
        <p className="text-sm text-foreground-light mt-2">
          There will be a brief connection interruption during the handover.
        </p>
      </ConfirmationModal>
    </>
  )
}
