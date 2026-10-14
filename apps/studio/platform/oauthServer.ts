// The apps' GoTrue runs without OAuth Server (GOTRUE_OAUTH_SERVER_ENABLED unset): its admin API answers "feature
// disabled", and the app's auth settings belong to the platform (configure_auth), not to Studio.
export const OAUTH_SERVER_UNAVAILABLE = {
  title: 'OAuth Server is not available on this platform',
  description:
    "Apps on this platform cannot act as an OAuth identity provider for third-party applications. Sign-in options are configured with the platform's configure_auth tool.",
}
