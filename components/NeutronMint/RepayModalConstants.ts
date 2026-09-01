export type DebtAssetSymbol = 'CDT' | 'USDC'

export interface DebtAsset {
    symbol: DebtAssetSymbol
    logo: string
    denom: string
}

export const DEBT_ASSETS: DebtAsset[] = [
    { symbol: 'CDT', logo: '/images/cdt.png', denom: 'factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt' },
    { symbol: 'USDC', logo: '/images/usdc.svg', denom: 'ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4' },
]
