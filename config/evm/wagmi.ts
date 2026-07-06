import { createConfig, http } from 'wagmi'
import { metaMask, injected } from 'wagmi/connectors'
import { supportedEvmChains } from './chains'

/**
 * wagmi config — the EVM replacement for cosmos-kit's ChainProvider setup in _app.tsx.
 * MetaMask is the recommended primary connector; injected() covers other browser wallets.
 * Transports default to each chain's configured RPC (env-driven, see ./chains.ts).
 */
export const wagmiConfig = createConfig({
  chains: supportedEvmChains,
  connectors: [metaMask(), injected()],
  transports: Object.fromEntries(supportedEvmChains.map((c) => [c.id, http()])),
  ssr: true,
})
