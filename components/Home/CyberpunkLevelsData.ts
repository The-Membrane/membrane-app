export interface Level {
    id: number
    name: string
    subtitle?: string
    description: string
    status: 'unlocked' | 'locked'
    color: string
    route?: string
}

export const levels: Level[] = [

    {
        id: 1,
        name: 'TRANSMUTER',
        subtitle: 'CDT <> USDC Exchange',
        description: 'Earn MBRN by providing USDC to fuel the transmutation of CDT to USDC.',
        status: 'unlocked',
        color: '#46d39a',
        route: 'transmuter'
    },
    {
        id: 2,
        name: 'MANIC',
        subtitle: 'Boosted stablecoin yield',
        description: 'Loop USDC supplied on Mars Protocol to boost your stablecoin yield by 10x.',
        status: 'unlocked',
        color: '#9bdc4f',
        route: 'manic'
    },
    {
        id: 3,
        name: 'LTV DISCO',
        subtitle: 'Revenue-fueled System Backstop',
        description: 'Deposit MBRN to earn protocol revenue in exchange for backstopping the system.',
        status: 'unlocked',
        color: '#9bdc4f',
        route: 'disco'
    },
    {
        id: 5,
        name: 'MAZE RUNNERS',
        subtitle: 'On-chain AI Racing Game',
        description: 'Train your own AI to traverse mazes, earn $BYTE and reign supreme as the world\'s #1.',
        status: 'unlocked',
        color: '#9bdc4f',
        route: 'maze-runners'
    },
    {
        id: 6,
        name: 'STAKE',
        subtitle: 'Staking Protocol',
        description: 'Stake MBRN to earn protocol rewards.',
        status: 'unlocked',
        color: '#9bdc4f',
        route: 'stake'
    },
    {
        id: 7,
        name: 'BRIDGE',
        subtitle: 'Osmosis -> Neutron MBRN Bridge',
        description: 'Bridge MBRN & transmute MBRN from Osmosis to use on Neutron.',
        status: 'unlocked',
        color: '#46d39a',
        route: 'bridge'
    }
]
