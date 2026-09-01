export interface MarketCreateState {
    name: string;
    collateralAsset: string;
    maxBorrowLTV: string;
    liquidationLTV: string;
    borrowFee: string;
    socialLinks: string;
    managerAddress: string;
    maxSlippage: number;
    totalDebtSupplyCap: string | undefined;
    osmosisPoolId: string;
    // Interest rate model params
    baseRate: string;
    rateMax: string;
    postKinkRateMultiplier: string | undefined;
    kinkStartingPointRatio: string | undefined;
    enableKink: boolean;
}
