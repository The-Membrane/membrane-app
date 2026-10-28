import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  // Pages Router SSR functions otherwise externalize the pnpm dependency graph
  // and can exhaust Vercel's file-descriptor limit during cold start (EMFILE).
  // Bundle those dependencies into the function chunks instead.
  bundlePagesRouterDependencies: true,
  // Bundle the wallet packages into the server output instead of leaving their
  // pnpm-linked ESM dependencies for the Vercel function to resolve at runtime.
  // Without this, traced functions can omit transitive files such as mipd and
  // then fail every SSR request with ERR_MODULE_NOT_FOUND.
  transpilePackages: [
    '@rainbow-me/rainbowkit',
    '@wagmi/connectors',
    '@wagmi/core',
    'cuer',
    'mipd',
    'wagmi',
  ],
  // R3 (docs/SEO_RULESET.md): routes deleted on the evm-migration branch keep
  // permanent redirects so old links and index entries land somewhere real.
  // Running map: docs/REDIRECT_MAP.md. `:chain` is already validated upstream
  // by middleware.ts (invalid chains 404 or 308 before these run).
  async redirects() {
    return [
      // Owner ruling 2026-10-28: '/' is the landing page (middleware.ts rewrites it
      // to pages/[chain]/index.tsx). The landing's old URL, the chain root, moves to
      // '/' with a permanent redirect so it has one URL and no duplicate (R2, R3).
      // The only supported chain is ethereum (config/chains.ts).
      { source: '/ethereum', destination: '/', permanent: true },
      // These pointed at '/:chain'; they now go straight to '/' so no redirect chains.
      { source: '/:chain/cityscape', destination: '/', permanent: true },
      { source: '/:chain/flywheel', destination: '/', permanent: true },
      { source: '/:chain/lockdrop', destination: '/', permanent: true },
      { source: '/:chain/manic', destination: '/', permanent: true },
      { source: '/:chain/isolated/:marketAddress/:symbol*', destination: '/:chain/isolated', permanent: true },
    ]
  },
  typescript: {
    // !! WARN !!
    // Dangerously allow production builds to successfully complete even if
    // your project has type errors.
    // !! WARN !!
    ignoreBuildErrors: true
  },
  eslint: {
    // Warning: This allows production builds to successfully complete even if
    // your project has ESLint errors.
    ignoreDuringBuilds: true
  },
  // Blog posts are read from disk at request time (helpers/blog.ts); make sure
  // the content dir ships with traced serverless output.
  outputFileTracingIncludes: {
    '/blog': ['./content/blog/**'],
    '/blog/[slug]': ['./content/blog/**'],
    '/sitemap.xml': ['./content/blog/**'],
  },
  webpack: (config, { isServer }) => {
    // Ensure chain-registry is properly resolved
    const chainRegistryPath = path.resolve(__dirname, 'node_modules/chain-registry');
    config.resolve.alias = {
      ...config.resolve.alias,
      'chain-registry': chainRegistryPath,
      // Optional wallet SDKs referenced by the @wagmi/connectors barrel that we
      // don't ship (we only use metaMask + injected; @metamask/connect-evm IS
      // installed). `false` stubs them out.
      porto: false,
      accounts: false,
      '@base-org/account': false,
      '@coinbase/wallet-sdk': false,
      '@safe-global/safe-apps-provider': false,
      '@safe-global/safe-apps-sdk': false,
      '@walletconnect/ethereum-provider': false,
    };
    // Also ensure proper module resolution
    config.resolve.modules = [
      ...(config.resolve.modules || []),
      path.resolve(__dirname, 'node_modules'),
    ];
    return config;
  },
};
export default nextConfig;
