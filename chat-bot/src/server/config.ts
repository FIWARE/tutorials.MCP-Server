export const config = {
  port: Number(process.env.PORT ?? '3005'),
  mcpUrl: process.env.MCP_URL ?? 'http://localhost:3003/mcp',
  authEnabled: process.env.AUTH_ENABLED === 'true',
  sessionSecret: process.env.SESSION_SECRET ?? 'tutorial-session-secret',
  oidc: {
    // In-network issuer, used for the token exchange and discovery.
    issuer: process.env.OIDC_ISSUER ?? 'http://keycloak:8080/realms/farm-management',
    // The browser is redirected to this one, so it must resolve from the host.
    publicIssuer:
      process.env.OIDC_PUBLIC_ISSUER ??
      process.env.OIDC_ISSUER ??
      'http://localhost:3005/realms/farm-management',
    clientId: process.env.OIDC_CLIENT_ID ?? 'ngsi-ld-farm',
    clientSecret: process.env.OIDC_CLIENT_SECRET ?? '1234',
    redirectUri: process.env.OIDC_REDIRECT_URI ?? 'http://localhost:3006/login/callback',
    scope: process.env.OIDC_SCOPE ?? 'openid profile email',
  },
};
