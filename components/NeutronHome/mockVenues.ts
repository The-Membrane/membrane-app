export interface Venue {
    id: string;
    name: string;
    tvl: string;
    apr: number;
    protocol: string;
    minHealth?: number;
}

export const MOCK_VENUES: Venue[] = [
    {
        id: 'astroport-ntrn-usdc',
        name: 'Astroport NTRN-USDC',
        tvl: '$2.4M',
        apr: 18.5,
        protocol: 'astroport',
    },
    {
        id: 'mars-protocol-lend',
        name: 'Mars Protocol Lend',
        tvl: '$1.8M',
        apr: 12.3,
        protocol: 'mars',
    },
    {
        id: 'levana-perps-vault',
        name: 'Levana Perps Vault',
        tvl: '$3.2M',
        apr: 24.7,
        protocol: 'levana',
        minHealth: 70,
    },
    {
        id: 'nolus-lease',
        name: 'Nolus Lease',
        tvl: '$950K',
        apr: 15.8,
        protocol: 'nolus',
    },
    {
        id: 'apollo-dao-vault',
        name: 'Apollo Vault',
        tvl: '$1.5M',
        apr: 16.2,
        protocol: 'apollo',
    },
    {
        id: 'membrane-earn',
        name: 'Membrane LP Pool',
        tvl: '$2.8M',
        apr: 22.1,
        protocol: 'membrane',
    },
    {
        id: 'astroport-atom-ntrn',
        name: 'Astroport ATOM-NTRN',
        tvl: '$1.9M',
        apr: 19.3,
        protocol: 'astroport',
    },
    {
        id: 'mars-savings',
        name: 'Mars Savings',
        tvl: '$4.1M',
        apr: 11.5,
        protocol: 'mars',
    },
];

