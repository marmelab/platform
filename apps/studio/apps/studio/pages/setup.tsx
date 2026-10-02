import { Lock } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { useEffect, useState } from 'react'
import { Button, Input_Shadcn_, Label_Shadcn_ } from 'ui'

import { SignInWithGitHub } from '@/components/interfaces/SignIn/SignInWithGitHub'
import { AuthenticationLayout } from '@/components/layouts/AuthenticationLayout'
import SignInLayout from '@/components/layouts/SignInLayout/SignInLayout'
import { useGoTrueProviders } from '@/hooks/misc/useGoTrueProviders'
import { STUDIO_AUTH_GOTRUE } from '@/lib/constants'
import type { NextPageWithLayout } from '@/types'

const SetupPage: NextPageWithLayout = () => {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const gotrueProviders = useGoTrueProviders()

  if (!STUDIO_AUTH_GOTRUE) {
    if (typeof window !== 'undefined') router.replace('/projects')
    return null
  }

  // Redirect to sign-in if admin already exists (e.g. user navigated here directly)
  useEffect(() => {
    fetch('/api/self-hosted/bootstrap')
      .then((r) => r.json())
      .then(({ bootstrapped }) => {
        if (bootstrapped) router.replace('/sign-in')
      })
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const res = await fetch('/api/self-hosted/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })

      const body = await res.json().catch(() => ({}))

      if (!res.ok) {
        if (res.status === 409) {
          router.replace('/sign-in')
          return
        }
        setError(body.error ?? 'Setup failed')
        return
      }

      // 200 with reset:true means password was updated for an existing admin
      router.replace('/sign-in')
    } catch {
      setError('Unable to reach the server. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {gotrueProviders.github && <SignInWithGitHub />}

      {gotrueProviders.sso && (
        <Button
          asChild
          block
          size="large"
          type="outline"
          icon={<Lock width={18} height={18} />}
        >
          <Link href={{ pathname: '/sign-in-sso', query: router.query }}>Continue with SSO</Link>
        </Button>
      )}

      {(gotrueProviders.github || gotrueProviders.sso) && (
        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-strong" />
          </div>
          <div className="relative flex justify-center text-sm">
            <span className="px-2 text-sm bg-studio text-foreground">or</span>
          </div>
        </div>
      )}

      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <p className="text-sm text-foreground-light">
          Create an admin account with email and password.
        </p>

        <div className="flex flex-col gap-1">
          <Label_Shadcn_ htmlFor="setup-email">Email</Label_Shadcn_>
          <Input_Shadcn_
            id="setup-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={loading}
            required
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label_Shadcn_ htmlFor="setup-password">Password</Label_Shadcn_>
          <Input_Shadcn_
            id="setup-password"
            type="password"
            autoComplete="new-password"
            placeholder="Min. 8 characters"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loading}
            required
            minLength={8}
          />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button block type="primary" htmlType="submit" loading={loading} disabled={loading}>
          Create admin account
        </Button>
      </form>
    </div>
  )
}

SetupPage.getLayout = (page) => (
  <AuthenticationLayout>
    <SignInLayout
      heading="Set up Studio"
      subheading="Create your admin account to get started"
      logoLinkToMarketingSite={false}
    >
      {page}
    </SignInLayout>
  </AuthenticationLayout>
)

export default SetupPage
