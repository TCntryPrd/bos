// WS2 — OAuth "create-your-own-app" setup guides.
//
// Static, ZERO-secret content registry that feeds the OAuthSetupWizard. Each
// tester/customer creates their OWN developer app and pastes their client id +
// secret; the BOS stores them via POST /api/connectors/oauth/configure and then
// runs the normal OAuth flow.
//
// The redirect URI is computed at RUNTIME from the browser origin — never
// hardcoded — so it is correct on every install (localhost, tailnet, domain).
// Path mirrors the API callback: /api/connectors/oauth/<provider>/callback.

export interface OAuthCredentialField {
  key: 'clientId' | 'clientSecret';
  label: string;
  secret?: boolean;
}

export interface OAuthProviderGuide {
  id: string;
  name: string;
  devPortalUrl: string;
  devPortalLabel: string;
  /** What kind of app the user creates, in plain language. */
  appType: string;
  /** Path appended to window.location.origin to build the redirect URI. */
  redirectUriPath: string;
  scopes: string[];
  /** Numbered, plain-language steps. */
  steps: string[];
  /** Shown as an amber caution (e.g. app-review delays). Optional. */
  warning?: string;
  credentialFields: OAuthCredentialField[];
}

const CRED_FIELDS: OAuthCredentialField[] = [
  { key: 'clientId', label: 'Client ID' },
  { key: 'clientSecret', label: 'Client Secret', secret: true },
];

export const OAUTH_GUIDES: Record<string, OAuthProviderGuide> = {
  google: {
    id: 'google',
    name: 'Google',
    devPortalUrl: 'https://console.cloud.google.com/apis/credentials',
    devPortalLabel: 'Google Cloud Console',
    appType: 'OAuth 2.0 Client ID (Web application) + an OAuth consent screen',
    redirectUriPath: '/api/connectors/oauth/google/callback',
    scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/drive'],
    steps: [
      'Open the Google Cloud Console and create (or pick) a project.',
      'Go to "APIs & Services → OAuth consent screen", choose External, and add yourself as a test user.',
      'Enable the Gmail, Calendar, and Drive APIs under "Enabled APIs & services" (only the ones you need).',
      'Go to "Credentials → Create Credentials → OAuth client ID", choose "Web application".',
      'Under "Authorized redirect URIs", paste the redirect URI shown on the right.',
      'Create it, then copy the Client ID and Client Secret into the form on the right.',
    ],
    warning: 'Restricted Gmail/Drive scopes require Google to verify your consent screen before non-test users can connect — this can take days. Start with just the scopes you need.',
    credentialFields: CRED_FIELDS,
  },
  slack: {
    id: 'slack',
    name: 'Slack',
    devPortalUrl: 'https://api.slack.com/apps',
    devPortalLabel: 'Slack API · Your Apps',
    appType: 'a Slack app created "from scratch"',
    redirectUriPath: '/api/connectors/oauth/slack/callback',
    scopes: ['chat:write', 'channels:read', 'channels:history', 'users:read', 'files:write'],
    steps: [
      'Open api.slack.com/apps and click "Create New App → From scratch".',
      'Name it and pick your workspace.',
      'Go to "OAuth & Permissions". Under "Redirect URLs", add the redirect URI shown on the right.',
      'Under "Scopes → Bot Token Scopes", add the scopes listed on the right.',
      'Go to "Basic Information" and copy the Client ID and Client Secret into the form.',
    ],
    credentialFields: CRED_FIELDS,
  },
  linkedin: {
    id: 'linkedin',
    name: 'LinkedIn',
    devPortalUrl: 'https://www.linkedin.com/developers/apps',
    devPortalLabel: 'LinkedIn Developers',
    appType: 'a LinkedIn app with "Sign In with LinkedIn using OpenID Connect" + "Share on LinkedIn"',
    redirectUriPath: '/api/connectors/oauth/linkedin/callback',
    scopes: ['openid', 'profile', 'email', 'w_member_social'],
    steps: [
      'Open linkedin.com/developers/apps and click "Create app" (you need a LinkedIn Company Page to associate it with).',
      'On the app\'s "Products" tab, request "Sign In with LinkedIn using OpenID Connect" and "Share on LinkedIn".',
      'On the "Auth" tab, under "Authorized redirect URLs", add the redirect URI shown on the right.',
      'Copy the Client ID and Primary Client Secret from the "Auth" tab into the form.',
    ],
    warning: 'Use the OpenID Connect scopes (openid/profile/email) — the older r_liteprofile / r_emailaddress scopes are deprecated. Company-page posting may require additional product approval.',
    credentialFields: CRED_FIELDS,
  },
  meta: {
    id: 'meta',
    name: 'Meta (Facebook / Instagram / Messenger)',
    devPortalUrl: 'https://developers.facebook.com/apps',
    devPortalLabel: 'Meta for Developers',
    appType: 'a "Business" app with Facebook Login, plus Instagram and Messenger products as needed',
    redirectUriPath: '/api/connectors/oauth/meta/callback',
    scopes: ['email', 'public_profile', 'pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish'],
    steps: [
      'Open developers.facebook.com/apps and click "Create App", choose the "Business" type.',
      'Add the "Facebook Login" product (and Instagram / Messenger if you use them).',
      'In "Facebook Login → Settings", under "Valid OAuth Redirect URIs", paste the redirect URI shown on the right.',
      'In "App settings → Basic", copy the App ID (Client ID) and App Secret (Client Secret) into the form.',
      'Add yourself as a tester/admin under "App Roles" while developing.',
    ],
    warning: 'Most Page/Instagram scopes require Business Verification and App Review before they work for anyone but admins/testers — this can take days. Develop with your own admin account first using the minimal scopes.',
    credentialFields: CRED_FIELDS,
  },
};

/** Build the absolute redirect URI for a provider from the current origin. */
export function redirectUriFor(guide: OAuthProviderGuide): string {
  const origin =
    (typeof window !== 'undefined' && window.location?.origin) || '';
  return `${origin}${guide.redirectUriPath}`;
}

export function getOAuthGuide(providerId: string): OAuthProviderGuide | null {
  return OAUTH_GUIDES[providerId] ?? null;
}
