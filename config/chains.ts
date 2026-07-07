/**
 * Route-level chain registry. EVM-only: there is exactly ONE chain path — /ethereum.
 * Legacy Cosmos entries (osmosis/osmosis-v2/neutron/…) are gone; stale URLs resolve to
 * ethereum via getChainConfig's fallback and useChainRoute's validation.
 *
 * The actual EVM network (anvil now, mainnet later) is configured separately in
 * config/evm/chains.ts via NEXT_PUBLIC_EVM_CHAIN_ID / NEXT_PUBLIC_EVM_RPC_URL — this
 * file only owns the URL segment and display metadata.
 */

export interface ChainConfig {
    name: string;
    displayName: string;
    walletChainName: string;
    logo: string;
    chainId: string;
    rpcUrl: string;
    addressPrefix: string;
}

export const supportedChains: ChainConfig[] = [
    {
        name: 'ethereum',
        displayName: 'Ethereum',
        walletChainName: 'ethereum',
        logo: '/images/Logo.svg',
        chainId: 'ethereum',
        // legacy Cosmos field — dead read paths only; the EVM RPC lives in config/evm/chains.ts
        rpcUrl: '',
        addressPrefix: '0x'
    }
];

export const DEFAULT_CHAIN = 'ethereum';

export const getChainConfig = (chainName: string): ChainConfig => {
    return supportedChains.find(chain => chain.name === chainName) || supportedChains[0];
};

export const getWalletChainName = (chainName: string): string => {
    const config = getChainConfig(chainName);
    return config.walletChainName;
};
