import { useRouter } from 'next/router'
import { useState } from 'react'
import { Button, Input_Shadcn_, Label_Shadcn_ } from 'ui'

export const SelfHostedSignInForm = () => {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const res = await fetch('/api/self-hosted/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'Invalid credentials')
        return
      }

      const redirectTo = (router.query.redirectedFrom as string) || '/projects'
      router.replace(redirectTo)
    } catch {
      setError('Unable to reach the server. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Label_Shadcn_ htmlFor="sh-email">Email</Label_Shadcn_>
        <Input_Shadcn_
          id="sh-email"
          type="text"
          autoComplete="email"
          placeholder="admin@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={loading}
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label_Shadcn_ htmlFor="sh-password">Password</Label_Shadcn_>
        <Input_Shadcn_
          id="sh-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={loading}
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button block type="primary" htmlType="submit" loading={loading} disabled={loading}>
        Sign in
      </Button>
    </form>
  )
}
