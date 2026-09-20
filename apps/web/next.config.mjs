/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  transpilePackages: ["@gitlit/core", "@gitlit/diff", "@gitlit/prose"],
  // Emit a self-contained server with only the modules actually reached, so
  // the runtime image carries no pnpm store and no workspace symlinks.
  output: "standalone",
  // The bundle traces imports from the repo root, not apps/web — without this
  // the workspace packages are left out of the standalone output.
  outputFileTracingRoot: new URL("../..", import.meta.url).pathname,
};
