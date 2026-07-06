import { useAccount, useConnect, useDisconnect, usePublicClient, useWalletClient } from 'wagmi'
import { DEFAULT_EVM_CHAIN } from '@/config/evm/chains'

/**
 * Wallet seam — EVM (wagmi) internals behind the same hook every feature consumes.
 * Was: cosmos-kit useChain(walletChainName).
 *
 * Legacy fields NOT provided anymore: sign/broadcast/estimateFee/getSigningCosmWasmClient/
 * getSigningStargateClient (the tx pipeline in useTransaction/useSimulate owns signing now)
 * and chain.bech32_prefix (EVM addresses are 0x…; see helpers/truncate.ts). Hooks that
 * consumed those are tracked in docs/audits/01-cosmos-callsite-ledger.md §2.
 *
 * @param _legacyChainName ignored — kept so pre-migration `useWallet(chainName)` call
 * sites compile until each is cleaned up.
 */
const useWallet = (_legacyChainName?: string) => {
  const { address, isConnected, chain, connector } = useAccount()
  const { connect: wagmiConnect, connectors, isPending: isConnecting } = useConnect()
  const { disconnect } = useDisconnect()
  const { data: walletClient } = useWalletClient()
  const publicClient = usePublicClient()

  const connect = () => {
    // MetaMask first (recommended pair), generic injected as fallback
    const preferred = connectors.find((c) => c.id === 'metaMaskSDK' || c.id === 'metaMask') ?? connectors[0]
    if (preferred) wagmiConnect({ connector: preferred })
  }

  return {
    address,
    isWalletConnected: isConnected,
    isConnecting,
    connect,
    disconnect: () => disconnect(),
    chain: chain ?? DEFAULT_EVM_CHAIN,
    connector,
    connectors,
    walletClient,
    publicClient,
  }
}

export default useWallet
