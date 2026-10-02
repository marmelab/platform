import { ShieldCheck } from 'lucide-react'
import {
  Alert_Shadcn_,
  AlertDescription_Shadcn_,
  AlertTitle_Shadcn_,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from 'ui'

import CopyButton from '@/components/ui/CopyButton'

type Project = {
  ref: string
  name: string
  public_url?: string
  authUrl?: string
}

function authCallbackUrl(p: Project): string | null {
  const base = (p.authUrl ?? p.public_url ?? '').replace(/\/$/, '')
  if (!base) return null
  // public_url ends at Kong; GoTrue is at /auth/v1
  return base.includes('/auth/v1') ? `${base}/callback` : `${base}/auth/v1/callback`
}

export function OAuthSetupPanel({ projects }: { projects: Project[] }) {
  return (
    <div className="flex flex-col gap-4">
      <Alert_Shadcn_>
        <ShieldCheck className="h-4 w-4" />
        <AlertTitle_Shadcn_>Register these URLs with every OAuth provider</AlertTitle_Shadcn_>
        <AlertDescription_Shadcn_>
          Each project runs its own GoTrue instance. Add the callback URL below to your allowed
          redirect list in Google, GitHub, GitLab, etc. Missing even one will break OAuth for that
          project.
        </AlertDescription_Shadcn_>
      </Alert_Shadcn_>

      <div className="rounded-md border border-strong overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead>Ref</TableHead>
              <TableHead>GoTrue OAuth callback URL</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {projects.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-foreground-muted py-8">
                  No projects found.
                </TableCell>
              </TableRow>
            )}
            {projects.map((p) => {
              const url = authCallbackUrl(p)
              return (
                <TableRow key={p.ref}>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell className="text-foreground-muted font-mono text-xs">{p.ref}</TableCell>
                  <TableCell className="font-mono text-xs text-foreground-muted">
                    {url ?? <span className="italic">No public URL configured</span>}
                  </TableCell>
                  <TableCell className="text-right">
                    {url && (
                      <CopyButton text={url} type="default" iconOnly className="h-7 w-7" />
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      <p className="text-foreground-muted text-xs">
        Site URL (the URL GoTrue redirects to after sign-in) should be set in each project&apos;s
        Auth &rarr; URL Configuration.
      </p>
    </div>
  )
}
