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
        rpcUrl: 'https://rpc.cosmos.directory/neutron',
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

export const DEFAULT_CHAIN = supportedChains[0].name;

export const getChainConfig = (chainName: string): ChainConfig => {
    return supportedChains.find(chain => chain.name === chainName) || supportedChains[0];
}; 