/** @type {import('next').NextConfig} */
const API_ORIGIN = (() => {
  try { return new URL(process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").origin; }
  catch { return "http://localhost:4000"; }
})();

/**
 * Security response headers.
 *
 * The session token is handed to the SPA in the callback URL (the cross-origin
 * cookie cannot be read by the app's fetch calls). `Referrer-Policy: no-referrer`
 * means that URL — and any token in it — is never sent in a Referer header, so
 * adding a Google Font or an avatar image later cannot start leaking it to a
 * third party. The CSP `connect-src` then confines where the app may send that
 * token to GitLit's own origins, so injected script cannot exfiltrate it; and
 * `frame-ancestors 'none'` keeps the sign-in page out of an attacker's iframe.
 */
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data:",
  // Next.js injects its bootstrap inline; 'unsafe-inline' is required for it to
  // run. Scripts still cannot be loaded from another origin.
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  `connect-src 'self' ${API_ORIGIN}`,
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

export default {
  reactStrictMode: true,
  transpilePackages: ["@gitlit/core", "@gitlit/diff", "@gitlit/prose"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // Emit a self-contained server with only the modules actually reached, so
  // the runtime image carries no pnpm store and no workspace symlinks.
  output: "standalone",
  // The bundle traces imports from the repo root, not apps/web — without this
  // the workspace packages are left out of the standalone output.
  outputFileTracingRoot: new URL("../..", import.meta.url).pathname,
};
