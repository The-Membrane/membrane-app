import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
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