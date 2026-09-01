import React from 'react';
import { VStack } from '@chakra-ui/react';

import { Asset } from '@/helpers/chain';
import useMyceliumState from './hooks/useMyceliumState';
import MyceliumHeader from './MyceliumHeader';
import MyceliumAmountInput from './MyceliumAmountInput';
import MyceliumLtvControl from './MyceliumLtvControl';
import MyceliumVenueSelector from './MyceliumVenueSelector';
import MyceliumGrowthChart from './MyceliumGrowthChart';
import MyceliumDeployAction from './MyceliumDeployAction';
import FAQ from './FAQ';

interface AssetProps {
    logo: string;
    symbol: string;
    large?: boolean;
    glowColor?: string;
    balance?: string;
    price?: string;
    maxBorrowLTV?: number;
    maxLTV?: string;
    marketContract: string;
    // TODO(evm-migration): optional so callers (NeutronHome index) can render before an asset is
    // resolved; basket-driven asset selection is null-stubbed under the EVM CDP service.
    asset?: Asset;
}

const Mycelium: React.FC<AssetProps> = ({ logo, large, glowColor, balance, price, maxBorrowLTV, maxLTV, marketContract, asset }) => {
    const {
        logoToShow,
        symbol,
        amount,
        setAmount,
        value,
        selectedAsset,
        setSelectedAssetBase,
        availableAssets,
        displayBalance,
        mode,
        resolvedMaxBorrowLTV,
        maxMultiplier,
        managedActionState,
        setManagedActionState,
        setSelectedMultiplier,
        ltvInputValue,
        setLtvInputValue,
        inputRef,
        selectedVenue,
        setSelectedVenue,
        carouselNavigateRef,
        getShowAllStateRef,
        chartData,
        transformExposure,
        collateralValue,
        borrowAmount,
    } = useMyceliumState({ logo, glowColor, balance, price, maxBorrowLTV, maxLTV, marketContract, asset });

    return (
        <VStack align="center" spacing={large ? 10 : 6} w="100%" mt={8}>
            <MyceliumHeader large={large} logoToShow={logoToShow} symbol={symbol} />

            {/* Amount input */}
            <MyceliumAmountInput
                large={large}
                amount={amount}
                setAmount={setAmount}
                value={value}
                logoToShow={logoToShow}
                symbol={symbol}
                selectedAsset={selectedAsset}
                setSelectedAssetBase={setSelectedAssetBase}
                availableAssets={availableAssets}
                asset={asset}
                displayBalance={displayBalance}
            />

            {/* Borrow LTV selection */}
            <MyceliumLtvControl
                large={large}
                amount={amount}
                mode={mode}
                resolvedMaxBorrowLTV={resolvedMaxBorrowLTV}
                managedActionState={managedActionState}
                maxMultiplier={maxMultiplier}
                setSelectedMultiplier={setSelectedMultiplier}
                setManagedActionState={setManagedActionState}
                ltvInputValue={ltvInputValue}
                setLtvInputValue={setLtvInputValue}
                inputRef={inputRef}
            />

            {/* Venue selection Card carousel */}
            <MyceliumVenueSelector
                selectedVenue={selectedVenue}
                setSelectedVenue={setSelectedVenue}
                carouselNavigateRef={carouselNavigateRef}
                getShowAllStateRef={getShowAllStateRef}
            />

            {/* Compound Yield Chart */}
            <MyceliumGrowthChart chartData={chartData} symbol={symbol} />

            {/* FAQ Section */}
            <FAQ />

            {/* Deploy button */}
            <MyceliumDeployAction
                amount={amount}
                managedActionState={managedActionState}
                transformExposure={transformExposure}
                mode={mode}
                selectedAsset={selectedAsset}
                asset={asset}
                borrowAmount={borrowAmount}
                collateralValue={collateralValue}
                resolvedMaxBorrowLTV={resolvedMaxBorrowLTV}
            />
        </VStack>
    );
};

export default Mycelium;
