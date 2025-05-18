import { rpcUrl } from "./defaults";

export interface ChainConfig {
    name: string;
    logo: string;
    chainId: string;
    rpcUrl: string;
}

export const supportedChains: ChainConfig[] = [
    {
        name: 'osmosis',
        logo: '/images/osmo.svg',
        chainId: 'osmosis-1',
        rpcUrl: rpcUrl
    },
    {
        name: 'neutron',
        logo: '/images/neutron.svg',
        chainId: 'neutron-1',
        rpcUrl: 'https://rpc.cosmos.directory/neutron'
    },
    {
        name: 'cosmoshub',
        logo: '/images/atom.svg',
        chainId: 'cosmoshub-4',
        rpcUrl: 'https://rpc.cosmos.directory/cosmoshub'
    }
];

export const DEFAULT_CHAIN = supportedChains[0].name;

export const getChainConfig = (chainName: string): ChainConfig => {
    return supportedChains.find(chain => chain.name === chainName) || supportedChains[0];
}; 