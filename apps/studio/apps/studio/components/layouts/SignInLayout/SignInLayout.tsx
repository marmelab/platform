import { useQueryClient } from '@tanstack/react-query'
import { getAccessToken, useFlag } from 'common'
import { useTheme } from 'next-themes'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { PropsWithChildren, useEffect, useState } from 'react'
import { tweets } from 'shared-data'

import { DocsButton } from '@/components/ui/DocsButton'
import { useIsFeatureEnabled } from '@/hooks/misc/useIsFeatureEnabled'
import { BASE_PATH, DOCS_URL, IS_PLATFORM } from '@/lib/constants'
import { auth, buildPathWithParams, getReturnToPath } from '@/lib/gotrue'

type SignInLayoutProps = {
  heading: string
  subheading: string
  showDisclaimer?: boolean
  logoLinkToMarketingSite?: boolean
}

const SignInLayout = ({
  heading,
  subheading,
  showDisclaimer = true,
  logoLinkToMarketingSite = false,
  children,
}: PropsWithChildren<SignInLayoutProps>) => {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { resolvedTheme } = useTheme()
  const ongoingIncident = useFlag('ongoingIncident')

  const {
    dashboardAuthShowTestimonial: showTestimonial,
    brandingLargeLogo: largeLogo,
    dashboardAuthShowTos: showTos,
  } = useIsFeatureEnabled([
    'dashboard_auth:show_testimonial',
    'branding:large_logo',
    'dashboard_auth:show_tos',
  ])

  // This useEffect redirects the user to MFA if they're already halfway signed in
  useEffect(() => {
    auth
      .initialize()
      .then(async ({ error }) => {
        if (error) {
          // if there was a problem signing in via the url, don't redirect
          return
        }

        const token = await getAccessToken()

        if (token) {
          const { data, error } = await auth.mfa.getAuthenticatorAssuranceLevel()
          if (error) {
            // if there was a problem signing in via the url, don't redirect
            return
          }

          if (data) {
            // we're already where we need to be
            if (router.pathname === '/sign-in-mfa') {
              return
            }
            if (data.currentLevel !== data.nextLevel) {
              const redirectTo = buildPathWithParams('/sign-in-mfa')
              router.replace(redirectTo)
              return
            }
          }

          await queryClient.resetQueries()
          router.push(getReturnToPath())
        }
      })
      .catch(() => {}) // catch all errors thrown by auth methods
  }, [])

  const [quote, setQuote] = useState<{
    text: string
    url: string
    handle: string
    img_url: string
  } | null>(null)

  useEffect(() => {
    // Weighted random selection
    // Calculate total weight (default weight is fallbackWeight for tweets without weight specified)
    const fallbackWeight = 1
    const totalWeight = tweets.reduce((sum, tweet) => sum + (tweet.weight ?? fallbackWeight), 0)

    // Generate random number between 0 and totalWeight
    const random = Math.random() * totalWeight

    // Find the selected tweet based on cumulative weights
    let accumulatedWeight = 0
    for (const tweet of tweets) {
      const weight = tweet.weight ?? fallbackWeight
      accumulatedWeight += weight
      if (random <= accumulatedWeight) {
        setQuote(tweet)
        break
      }
    }
  }, [])

  return (
    <>
      <div className="relative flex flex-col bg-alternative min-h-screen">
        <div
          className={`absolute top-0 w-full px-8 mx-auto sm:px-6 lg:px-8 ${
            ongoingIncident ? 'mt-14' : 'mt-6'
          }`}
        >
          <nav className="relative flex items-center justify-between sm:h-10">
            <div className="flex items-center flex-grow flex-shrink-0 lg:flex-grow-0">
              <div className="flex items-center justify-between w-full md:w-auto">
                <Link href={logoLinkToMarketingSite ? 'https://supabase.com' : '/organizations'}>
                  <img
                    src={
                      resolvedTheme?.includes('dark')
                        ? `${BASE_PATH}/img/supabase-dark.svg`
                        : `${BASE_PATH}/img/supabase-light.svg`
                    }
                    alt="Supabase Logo"
                    className={largeLogo ? 'h-[48px]' : 'h-[24px]'}
                  />
                </Link>
              </div>
            </div>

            <div className="items-center hidden space-x-3 md:ml-10 md:flex md:pr-4">
              <DocsButton abbrev={false} href={`${DOCS_URL}`} />
            </div>
          </nav>
        </div>

        <div className="flex flex-1 h-full">
          <main className="flex flex-col items-center flex-1 flex-shrink-0 px-5 pt-16 pb-8 border-r shadow-lg bg-studio border-default">
            <div className="flex-1 flex flex-col justify-center w-[330px] sm:w-[384px]">
              <div className="mb-10">
                <h1 className="mt-8 mb-2 lg:text-3xl">{heading}</h1>
                <h2 className="text-sm text-foreground-light">{subheading}</h2>
              </div>

              {children}
            </div>

            {showDisclaimer && showTos && (
              <div className="text-center text-balance">
                <p className="text-xs text-foreground-lighter sm:mx-auto sm:max-w-sm">
                  By continuing, you agree to Supabase’s{' '}
                  <Link
                    href="https://supabase.com/terms"
                    className="underline hover:text-foreground-light"
                  >
                    Terms of Service
                  </Link>{' '}
                  and{' '}
                  <Link
                    href="https://supabase.com/privacy"
                    className="underline hover:text-foreground-light"
                  >
                    Privacy Policy
                  </Link>
                  , and to receive periodic emails with updates.
                </p>
              </div>
            )}
          </main>

          <aside className="flex-col items-center justify-center flex-1 flex-shrink hidden basis-1/4 xl:flex">
            {!IS_PLATFORM ? (
              <div className="flex flex-col items-center gap-6 text-center">
                <svg
                  viewBox="0 0 24 24"
                  className="w-16 h-16 text-foreground-light"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M12 0C5.37 0 0 5.373 0 12c0 5.303 3.438 9.8 8.205 11.387.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.015 2.896-.015 3.286 0 .322.216.694.825.576C20.565 21.795 24 17.298 24 12c0-6.627-5.373-12-12-12z" />
                </svg>
                <div className="flex flex-col gap-2">
                  <h3 className="text-xl font-medium text-foreground">Supabase Studio Multi-Head</h3>
                  <p className="text-sm text-foreground-light max-w-xs">
                    Self-hosted, multi-org Supabase Dashboard. Manage multiple projects from a single
                    interface.
                  </p>
                </div>
                <a
                  href="https://github.com/flamingrubberduck/supabase-studio-multi-head"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 px-4 py-2 rounded-md border border-default text-sm text-foreground-light hover:text-foreground hover:border-foreground-muted transition-colors"
                >
                  <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor" aria-hidden="true">
                    <path d="M12 0C5.37 0 0 5.373 0 12c0 5.303 3.438 9.8 8.205 11.387.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.015 2.896-.015 3.286 0 .322.216.694.825.576C20.565 21.795 24 17.298 24 12c0-6.627-5.373-12-12-12z" />
                  </svg>
                  View on GitHub
                </a>
              </div>
            ) : (
              quote !== null &&
              showTestimonial && (
                <div className="relative flex flex-col gap-6">
                  <div className="absolute select-none -top-12 -left-11">
                    <span className="text-[160px] leading-none text-foreground-muted/30">{'"'}</span>
                  </div>

                  <blockquote className="z-10 max-w-lg text-3xl">{quote.text}</blockquote>

                  <a
                    href={quote.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-4"
                  >
                    <img
                      src={`https://supabase.com${quote.img_url}`}
                      alt={quote.handle}
                      className="w-12 h-12 rounded-full"
                    />

                    <div className="flex flex-col">
                      <cite className="not-italic font-medium text-foreground-light whitespace-nowrap">
                        @{quote.handle}
                      </cite>
                    </div>
                  </a>
                </div>
              )
            )}
          </aside>
        </div>
      </div>
    </>
  )
}

export default SignInLayout
