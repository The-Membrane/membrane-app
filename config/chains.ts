import { rpcUrl } from "./defaults";

export interface ChainConfig {
    name: string;
    logo: string;
    chainId: string;
    rpcUrl: string;
    addressPrefix: string;
}

export const supportedChains: ChainConfig[] = [
    {
        name: 'osmosis',
        logo: '/images/osmo.svg',
        chainId: 'osmosis-1',
        rpcUrl: rpcUrl,
        addressPrefix: 'osmo'
    },
    {
        name: 'neutron',
        logo: '/images/ntrn.svg',
        chainId: 'neutron-1',
        rpcUrl: 'https://rpc-celatone.neutron-1.neutron.org',
        addressPrefix: 'neutron'
    },
    {
        name: 'neutrontestnet',
        logo: '/images/ntrn.svg',
        chainId: 'pion-1',
        rpcUrl: 'https://rpc-celatone.pion-1.ntrn.tech',
        addressPrefix: 'neutron'
    },
    {
        name: 'cosmoshub',
        logo: '/images/atom.svg',
        chainId: 'cosmoshub-4',
        rpcUrl: 'https://rpc.cosmos.directory/cosmoshub',
        addressPrefix: 'cosmos'
    }
];

export const DEFAULT_CHAIN = supportedChains[1].name;

export const getChainConfig = (chainName: string): ChainConfig => {
    return supportedChains.find(chain => chain.name === chainName) || supportedChains[0];
}; 