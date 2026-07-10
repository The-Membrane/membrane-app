import { http } from 'wagmi'
import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { supportedEvmChains } from './chains'

/**
 * wagmi config — the EVM replacement for cosmos-kit's ChainProvider setup in _app.tsx.
 *
 * Built via RainbowKit's `getDefaultConfig`, which wires the standard wallet picker
 * connector set (MetaMask, injected/browser wallet, WalletConnect, Coinbase Wallet,
 * Rainbow) on top of wagmi's `createConfig`. RainbowKit's <RainbowKitProvider> in
 * _app.tsx renders the connect modal; useWallet() keeps consuming plain wagmi hooks.
 *
 * WalletConnect (and therefore mobile/QR connections) needs a projectId. Set a real
 * one via NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID (free from https://cloud.reown.com).
 * The placeholder below lets injected + MetaMask work locally without any setup, but
 * WalletConnect/Coinbase-via-WC will not initialize until a real id is provided.
 */
const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? 'PLACEHOLDER_SET_NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID'

export const wagmiConfig = getDefaultConfig({
  appName: 'Membrane',
  projectId: WALLETCONNECT_PROJECT_ID,
  chains: supportedEvmChains,
  transports: Object.fromEntries(supportedEvmChains.map((c) => [c.id, http()])),
  ssr: true,
})
