'use client'

import { useState } from 'react'
import { ExternalLink, Eye, EyeOff } from 'lucide-react'
import { Button } from 'ui'

interface Props {
  adminEmail: string
  adminPassword: string
  publicUrl: string
}

export function PocketBaseProjectPanel({ adminEmail, adminPassword, publicUrl }: Props) {
  const [showPassword, setShowPassword] = useState(false)

  const adminUiUrl = `${publicUrl}/_/`

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <div className="rounded-md border border-strong overflow-hidden">
        <div className="px-4 py-3 border-b border-strong bg-surface-200">
          <h3 className="text-sm font-medium">PocketBase Admin</h3>
        </div>
        <div className="p-4 flex flex-col gap-4">
          <Row label="Admin UI">
            <a
              href={adminUiUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-brand hover:underline font-mono text-xs"
            >
              {adminUiUrl}
              <ExternalLink size={11} />
            </a>
          </Row>
          <Row label="Admin email">
            <span className="font-mono text-xs">{adminEmail}</span>
          </Row>
          <Row label="Admin password">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs">
                {showPassword ? adminPassword : '•'.repeat(Math.min(adminPassword.length, 20))}
              </span>
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="text-foreground-muted hover:text-foreground transition-colors"
              >
                {showPassword ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
          </Row>
          <Row label="REST API">
            <span className="font-mono text-xs">{publicUrl}/api/</span>
          </Row>
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          type="primary"
          icon={<ExternalLink size={14} />}
          onClick={() => window.open(adminUiUrl, '_blank')}
        >
          Open PocketBase Admin
        </Button>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 items-center">
      <span className="text-foreground-muted text-sm w-32 shrink-0">{label}</span>
      <span className="flex-1">{children}</span>
    </div>
  )
}
