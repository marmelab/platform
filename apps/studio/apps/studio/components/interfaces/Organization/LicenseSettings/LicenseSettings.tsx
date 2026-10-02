'use client'

import { ExternalLink, KeyRound, ShieldCheck, ShieldOff } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  Alert_Shadcn_,
  AlertDescription_Shadcn_,
  AlertTitle_Shadcn_,
  Badge,
  Button,
  Input_Shadcn_,
  Label_Shadcn_,
} from 'ui'
import {
  PageSection,
  PageSectionContent,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from 'ui-patterns/PageSection'
import { ConfirmationModal } from 'ui-patterns/Dialogs/ConfirmationModal'

import { useLicenseActivateMutation, useLicenseDeactivateMutation } from '@/data/license/license-mutation'
import { useLicenseStatusQuery } from '@/data/license/license-query'

const LEMONSQUEEZY_STORE_URL = process.env.NEXT_PUBLIC_LEMONSQUEEZY_STORE_URL ?? 'https://flamingrubberduck.lemonsqueezy.com'

export function LicenseSettings() {
  const { data: license, isLoading } = useLicenseStatusQuery()
  const [keyInput, setKeyInput] = useState('')
  const [showDeactivateModal, setShowDeactivateModal] = useState(false)

  const { mutate: activate, isPending: isActivating } = useLicenseActivateMutation({
    onSuccess: () => {
      toast.success('Pro license activated!')
      setKeyInput('')
    },
    onError: (error) => {
      toast.error(error.message)
    },
  })

  const { mutate: deactivate, isPending: isDeactivating } = useLicenseDeactivateMutation({
    onSuccess: () => {
      toast.success('License removed. Running as Free tier.')
    },
  })

  const isPro = license?.tier === 'pro'

  return (
    <>
      <PageSection>
        <PageSectionMeta>
          <PageSectionSummary>
            <PageSectionTitle>License</PageSectionTitle>
          </PageSectionSummary>
        </PageSectionMeta>

        <PageSectionContent>
          {/* Current status */}
          <div className="flex items-center gap-3 mb-6">
            {isLoading ? (
              <Badge variant="default">Checking…</Badge>
            ) : isPro ? (
              <>
                <ShieldCheck size={18} className="text-brand" />
                <Badge variant="success" className="font-semibold">Pro</Badge>
                {license.email && (
                  <span className="text-sm text-foreground-light">Licensed to {license.email}</span>
                )}
              </>
            ) : (
              <>
                <ShieldOff size={18} className="text-foreground-muted" />
                <Badge variant="default">Free</Badge>
              </>
            )}
          </div>

          {/* Grace period warning */}
          {license?.grace && (
            <Alert_Shadcn_ variant="warning" className="mb-6">
              <AlertTitle_Shadcn_>License server unreachable</AlertTitle_Shadcn_>
              <AlertDescription_Shadcn_>
                Studio cannot reach the license server. Your Pro license is active under the 7-day
                grace period. Check your network or{' '}
                <a href={LEMONSQUEEZY_STORE_URL} target="_blank" rel="noopener noreferrer" className="underline">
                  contact support
                </a>
                .
              </AlertDescription_Shadcn_>
            </Alert_Shadcn_>
          )}

          {isPro ? (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-foreground-light">
                Your Pro license is active. Standby provisioning, failover, and cluster mode are
                enabled.
              </p>
              <div>
                <Button
                  type="danger"
                  onClick={() => setShowDeactivateModal(true)}
                  loading={isDeactivating}
                >
                  Remove license
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              <p className="text-sm text-foreground-light">
                Upgrade to Pro to unlock standby provisioning, one-click failover, and read
                replica cluster mode.
              </p>

              <div className="flex flex-col gap-2">
                <Label_Shadcn_ htmlFor="license-key">License key</Label_Shadcn_>
                <div className="flex gap-2">
                  <Input_Shadcn_
                    id="license-key"
                    type="password"
                    placeholder="Paste your license key here"
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    className="font-mono text-sm flex-1"
                    disabled={isActivating}
                  />
                  <Button
                    type="primary"
                    onClick={() => {
                      if (!keyInput.trim()) return
                      activate({ key: keyInput.trim() })
                    }}
                    loading={isActivating}
                    disabled={!keyInput.trim()}
                    icon={<KeyRound size={14} />}
                  >
                    Activate
                  </Button>
                </div>
                <p className="text-xs text-foreground-muted">
                  You'll receive this key by email after purchase. It activates immediately — no
                  restart required.
                </p>
              </div>

              <div>
                <Button
                  asChild
                  type="default"
                  iconRight={<ExternalLink size={14} />}
                >
                  <a href={LEMONSQUEEZY_STORE_URL} target="_blank" rel="noopener noreferrer">
                    Buy Pro license
                  </a>
                </Button>
              </div>
            </div>
          )}
        </PageSectionContent>
      </PageSection>

      <ConfirmationModal
        visible={showDeactivateModal}
        title="Remove Pro license"
        description="Your Studio will downgrade to the Free tier immediately. Pro features (standby, failover, cluster mode) will stop working. You can re-activate at any time with your license key."
        confirmLabel="Remove license"
        confirmLabelLoading="Removing…"
        variant="destructive"
        onConfirm={() => {
          setShowDeactivateModal(false)
          deactivate()
        }}
        onCancel={() => setShowDeactivateModal(false)}
        loading={isDeactivating}
      />
    </>
  )
}
