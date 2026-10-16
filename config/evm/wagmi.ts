import { fallback, http } from 'wagmi'
import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import type { Chain } from 'viem'

import { PUBLIC_MAINNET_RPCS } from '@/lib/position-sim/rpc'

import { executionOnlyChains, supportedEvmChains } from './chains'

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

/**
 * The app's chains first, so chains[0] (the config's starting chain) stays the app's own;
 * then the execution-only chains (config/evm/chains.ts: Ethereum, for the /position levers).
 */
const chains: readonly [Chain, ...Chain[]] = [...supportedEvmChains, ...executionOnlyChains]

/** Ethereum's transport: the same keyless endpoints, in the same order, as the page's reads (lib/position-sim/rpc.ts). */
const mainnetUrls = process.env.NEXT_PUBLIC_MAINNET_RPC_URL
  ? [process.env.NEXT_PUBLIC_MAINNET_RPC_URL, ...PUBLIC_MAINNET_RPCS]
  : [...PUBLIC_MAINNET_RPCS]

export const wagmiConfig = getDefaultConfig({
  appName: 'Membrane',
  projectId: WALLETCONNECT_PROJECT_ID,
  chains,
  transports: {
    ...Object.fromEntries(supportedEvmChains.map((c) => [c.id, http()])),
    ...Object.fromEntries(executionOnlyChains.map((c) => [c.id, fallback(mainnetUrls.map((u) => http(u)), { rank: false })])),
  },
  ssr: true,
  // The config's chain never follows a wallet: with Ethereum configured, a wallet on
  // Ethereum would otherwise move it, and every usePublicClient() / useWalletClient()
  // without an explicit chainId (the app's reads and CTAs) would turn to mainnet. Off,
  // it stays chains[0], as it always was while the app's chain was the only one.
  syncConnectedChain: false,
})
