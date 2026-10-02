import { HardDrive } from 'lucide-react'
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
}

function storageUrl(p: Project): string | null {
  const base = (p.public_url ?? '').replace(/\/$/, '')
  if (!base) return null
  return `${base}/storage/v1`
}

export function StoragePanel({ projects }: { projects: Project[] }) {
  return (
    <div className="flex flex-col gap-4">
      <Alert_Shadcn_>
        <HardDrive className="h-4 w-4" />
        <AlertTitle_Shadcn_>Storage API endpoints per project</AlertTitle_Shadcn_>
        <AlertDescription_Shadcn_>
          Each project has its own Storage service. Use these URLs when configuring a CDN (e.g.
          Cloudflare, CloudFront) or when initialising the Supabase client in your app. Public file
          URLs follow the pattern:{' '}
          <code className="text-xs bg-surface-300 px-1 py-0.5 rounded">
            &lt;Storage API&gt;/object/public/&lt;bucket&gt;/&lt;file&gt;
          </code>
        </AlertDescription_Shadcn_>
      </Alert_Shadcn_>

      <div className="rounded-md border border-strong overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead>Ref</TableHead>
              <TableHead>Storage API URL</TableHead>
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
              const url = storageUrl(p)
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
        To add a CDN, proxy requests to the Storage API URL above and cache responses from{' '}
        <code className="text-xs bg-surface-300 px-1 py-0.5 rounded">/object/public/</code>.
        Authenticated uploads still go directly to the Storage API.
      </p>
    </div>
  )
}
