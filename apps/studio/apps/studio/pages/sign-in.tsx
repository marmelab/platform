import { Lock } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { useEffect, useState } from 'react'
import { Button } from 'ui'

import { LastSignInWrapper } from '@/components/interfaces/SignIn/LastSignInWrapper'
import { SelfHostedSignInForm } from '@/components/interfaces/SignIn/SelfHostedSignInForm'
import { SignInForm } from '@/components/interfaces/SignIn/SignInForm'
import { SignInWithCustom } from '@/components/interfaces/SignIn/SignInWithCustom'
import { SignInWithGitHub } from '@/components/interfaces/SignIn/SignInWithGitHub'
import { AuthenticationLayout } from '@/components/layouts/AuthenticationLayout'
import SignInLayout from '@/components/layouts/SignInLayout/SignInLayout'
import { useCustomContent } from '@/hooks/custom-content/useCustomContent'
import { useGoTrueProviders } from '@/hooks/misc/useGoTrueProviders'
import { useIsFeatureEnabled } from '@/hooks/misc/useIsFeatureEnabled'
import { IS_PLATFORM, STUDIO_AUTH_GOTRUE } from '@/lib/constants'
import type { NextPageWithLayout } from '@/types'

const SignInPage: NextPageWithLayout = () => {
  const router = useRouter()
  const [selfHostedAuthRequired, setSelfHostedAuthRequired] = useState<boolean | null>(null)

  const {
    dashboardAuthSignInWithGithub: signInWithGithubEnabled,
    dashboardAuthSignInWithSso: signInWithSsoEnabled,
    dashboardAuthSignInWithEmail: signInWithEmailEnabled,
    dashboardAuthSignUp: signUpEnabled,
  } = useIsFeatureEnabled([
    'dashboard_auth:sign_in_with_github',
    'dashboard_auth:sign_in_with_sso',
    'dashboard_auth:sign_in_with_email',
    'dashboard_auth:sign_up',
  ])

  const { dashboardAuthCustomProvider: customProvider } = useCustomContent([
    'dashboard_auth:custom_provider',
  ])

  const gotrueProviders = useGoTrueProviders()

  // In GoTrue mode show OAuth providers only when GoTrue has them enabled
  const showGithub = signInWithGithubEnabled || (STUDIO_AUTH_GOTRUE && gotrueProviders.github)
  const showSso = signInWithSsoEnabled || (STUDIO_AUTH_GOTRUE && gotrueProviders.sso)
  const showEmail = signInWithEmailEnabled || STUDIO_AUTH_GOTRUE

  const showOrDivider = (showGithub || showSso || customProvider) && showEmail

  useEffect(() => {
    if (STUDIO_AUTH_GOTRUE) {
      // Redirect to setup if no admin has been created yet
      fetch('/api/self-hosted/bootstrap')
        .then((r) => r.json())
        .then(({ bootstrapped }) => {
          if (!bootstrapped) router.replace('/setup')
          // bootstrapped=true → stay on sign-in (correct page)
        })
        .catch(() => {
          // ignore network errors, stay on sign-in
        })
      return
    }
    if (!IS_PLATFORM) {
      fetch('/api/self-hosted/session')
        .then((r) => r.json())
        .then(({ required }) => {
          if (!required) {
            router.replace('/projects')
          } else {
            setSelfHostedAuthRequired(true)
          }
        })
        .catch(() => router.replace('/projects'))
    }
  }, [router])

  if (!IS_PLATFORM && !STUDIO_AUTH_GOTRUE && selfHostedAuthRequired) {
    return <SelfHostedSignInForm />
  }

  // In GoTrue mode the real sign-in form below handles everything (same as platform)

  return (
    <>
      <div className="flex flex-col gap-5">
        {customProvider && <SignInWithCustom providerName={customProvider} />}
        {showGithub && <SignInWithGitHub />}
        {showSso && (
          <LastSignInWrapper type="sso">
            <Button
              asChild
              block
              size="large"
              type="outline"
              icon={<Lock width={18} height={18} />}
            >
              <Link
                href={{
                  pathname: '/sign-in-sso',
                  query: router.query,
                }}
              >
                Continue with SSO
              </Link>
            </Button>
          </LastSignInWrapper>
        )}

        {showOrDivider && (
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-strong" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-2 text-sm bg-studio text-foreground">or</span>
            </div>
          </div>
        )}
        {showEmail && <SignInForm />}
      </div>

      {signUpEnabled && (
        <div className="self-center my-8 text-sm">
          <div>
            <span className="text-foreground-light">Don’t have an account?</span>{' '}
            <Link
              href={{
                pathname: '/sign-up',
                query: router.query,
              }}
              className="underline transition text-foreground hover:text-foreground-light"
            >
              Sign up
            </Link>
          </div>
        </div>
      )}
    </>
  )
}

SignInPage.getLayout = (page) => (
  <AuthenticationLayout>
    <SignInLayout
      heading="Welcome back"
      subheading="Sign in to your account"
      logoLinkToMarketingSite={true}
    >
      {page}
    </SignInLayout>
  </AuthenticationLayout>
)

export default SignInPage
