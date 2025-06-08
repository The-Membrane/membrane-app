import { parseError } from "@/helpers/parseError"
import Select from '@/components/Select'
import { Stack, HStack, Input, Button, Text, Image, Card } from "@chakra-ui/react"
import useMintState from "./hooks/useMintState";
import { useEffect, useMemo, useState } from "react";
import { AssetWithBalance } from "./hooks/useCombinBalance";
import { getSummary } from "@/helpers/mint";
import { num } from "@/helpers/num";
import { MintInput } from "./MintInput";
import React from "react";


// Helper function to get the list of assets to display
//@ts-ignore
const DepositingText = ({ selectedAsset, ossifiedDeposits, transactionValue, onAssetClick }) => {
    // Helper function to get the list of assets to display
    const getAssetsList = () => {
        if (selectedAsset && Number(transactionValue) > 0) {
            return ossifiedDeposits
                .concat([{ ...selectedAsset, amountValue: transactionValue, txType: "deposit" }])
                .filter(asset => asset && asset.amountValue > 0 && asset.txType === "deposit");
        }
        return ossifiedDeposits
            .filter(asset => asset && asset.amountValue > 0 && asset.txType === "deposit");
    };

    const assets = getAssetsList() ?? [];

    return (
        <>
            {assets.map((asset, index) => (
                <React.Fragment key={`${asset.symbol}-${index}`}>
                    <Text
                        as="span"
                        color="white"
                        fontWeight="400"
                        textDecoration={selectedAsset && asset && selectedAsset.symbol === asset.symbol ? undefined : "underline"}
                        cursor={selectedAsset && asset && selectedAsset.symbol === asset.symbol ? undefined : "pointer"}
                        onClick={() => onAssetClick(asset.symbol)}
                        _hover={selectedAsset && asset && selectedAsset.symbol === asset.symbol ? undefined : { opacity: 0.8 }}
                    >
                        ${`${Number(asset.amountValue).toFixed(2)} ${asset.symbol}`}
                    </Text>
                    {index < assets.length - 1 && (
                        <Text as="span" color="white" fontWeight="400">
                            {", "} &nbsp;
                        </Text>
                    )}
                </React.Fragment>
            ))}
        </>
    );
};

export const InitialCDPDeposit = () => {
    const [transactionValue, setTransactionValue] = useState('');
    const { mintState, setMintState } = useMintState();

    const [selectedAsset, setSelectedAsset] = useState<AssetWithBalance | undefined>(undefined);

    const [ossifiedDeposits, setOssifiedDeposits] = useState<AssetWithBalance[]>([]);


    const assetsWithOptions = useMemo(() => {
        return mintState.assets
            ?.filter((asset) => !ossifiedDeposits.some(a => a.symbol === asset?.symbol))
            .map((asset) => ({
                ...asset,
                value: asset?.symbol,
                label: asset?.symbol,
            }))
    }, [mintState.assets, ossifiedDeposits]);

    useEffect(() => {
        if (mintState.assets && mintState.assets.length > 0 && assetsWithOptions?.[0] && (!selectedAsset || selectedAsset?.walletsdValue === 0)) {
            setSelectedAsset(assetsWithOptions?.[0]);
        }
    }, [assetsWithOptions]);

    //Handle Reset Button
    useEffect(() => {
        setTransactionValue("");
        setOssifiedDeposits([]);

    }, [mintState.reset]);

    //On deposit Asset click, remove the asset from the ossified deposits & set it as the selected asset
    const onAssetClick = (symbol: string) => {
        const asset = ossifiedDeposits.find((a) => a.symbol === symbol);
        if (!asset) return;

        const filteredOssifications = ossifiedDeposits.filter((a) => a.symbol !== symbol);
        setOssifiedDeposits(filteredOssifications);
        if (selectedAsset) {
            handleTransaction("deposit", selectedAsset?.walletsdValue ?? 0);
            setOssifiedDeposits([...filteredOssifications, { ...selectedAsset, amountValue: transactionValue, txType: "deposit" }]);
        }
        //Remove it from deposit summary by handling a 0 deposit
        console.log("asset symbol in fn", symbol)
        handleTransaction("deposit", 1, symbol);

        setSelectedAsset(asset);
        setTransactionValue("")
    };


    const handleTransaction = (transactionType: string, transactionValue: number, asset?: string) => {
        console.log("transactionType", transactionType, transactionValue)
        if (!transactionType || transactionValue <= 0) return;

        let updatedAssets = mintState.assets.map((a) => {
            if (a.symbol !== (asset ?? selectedAsset?.symbol)) return a;
            // console.log("asset made it thru", a)

            console.log("asset param", asset)
            if (asset) {
                console.log("asset made it thru", a, asset)

                return {
                    ...a,
                    amount: 0,
                    amountValue: 0,
                    sliderValue: a.depositUsdValue || 0,
                }
            }

            const sliderValue = transactionType === "deposit" ? Number(transactionValue) : -Number(transactionValue);

            const diffInUsd = num(selectedAsset?.depositUsdValue).minus(sliderValue).toNumber()
            const newDeposit = num(selectedAsset?.depositUsdValue).minus(diffInUsd).toNumber()
            const amountValue = num(diffInUsd).isGreaterThan(selectedAsset?.depositUsdValue ?? 0)
                ? newDeposit
                : -diffInUsd
            // console.log("asset stats", selectedAsset.depositUsdValue, sliderValue, diffInUsd, newDeposit, amountValue)
            const amount = num(amountValue).dividedBy(selectedAsset?.price ?? 1).dp(selectedAsset?.decimal ?? 6).toNumber()
            //
            //
            return {
                ...selectedAsset,
                amount,
                amountValue,
                sliderValue,
            }
        });
        console.log("updatedAssets", updatedAssets)

        const { summary, totalUsdValue } = getSummary(updatedAssets);
        console.log("summary", summary)

        setMintState({ assets: updatedAssets, summary, totalUsdValue });
    };

    const onChange = (value: AssetWithBalance) => {
        setSelectedAsset(value);
        setTransactionValue("");
    }

    console.log("selectedAsset", selectedAsset);

    //TODO:
    //- Make asset button correctly dynamic for deposits/withdraws & mint/repay combos

    //- Change all Mint lingo to Borrow (Tweet this)

    //- Place redemption card in a modal somewhere

    return (
        <Stack>
            <Stack>
                {((selectedAsset && Number(transactionValue) > 0) || (ossifiedDeposits && ossifiedDeposits.length > 0) || (mintState.newDebtAmount && mintState.newDebtAmount != 0)) && (
                    <Stack pt="4">
                        {((selectedAsset && Number(transactionValue) > 0) || (ossifiedDeposits && ossifiedDeposits.length > 0)) && (
                            <Text variant="title" textTransform="none" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
                                Depositing: &nbsp;
                                <DepositingText selectedAsset={selectedAsset} ossifiedDeposits={ossifiedDeposits} transactionValue={transactionValue} onAssetClick={onAssetClick} />
                            </Text>
                        )}

                        {mintState.newDebtAmount && mintState.newDebtAmount !== 0 && (
                            <Text variant="title" textTransform="none" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
                                Borrowing: &nbsp;<Text as="span" color="white" fontWeight="400">{mintState.newDebtAmount} CDT</Text>
                            </Text>
                        )}

                    </Stack>
                )}

                {assetsWithOptions && assetsWithOptions.length != 0 && <><div style={{ width: "fit-content", alignSelf: "center", marginTop: "3%" }}><Select options={assetsWithOptions} onChange={onChange} value={selectedAsset} /></div>
                    <HStack mt="2%" width="100%" justifyContent="left">
                        <HStack width="75%">
                            {selectedAsset && selectedAsset.logo && <Image src={selectedAsset?.logo} w="30px" h="30px" />}
                            <Text variant="title" textTransform={"none"} textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
                                Deposit {selectedAsset?.symbol}
                            </Text>
                        </HStack>
                    </HStack>
                    <Input
                        width={"100%"}
                        textAlign={"right"}
                        placeholder="Enter Amount"
                        type="number"
                        variant={"ghost"}
                        value={Number(transactionValue)}
                        max={selectedAsset?.walletsdValue}
                        onChange={(e) => {
                            e.preventDefault();
                            setTransactionValue(Math.min(Number(e.target.value), (selectedAsset?.walletsdValue ?? 0)).toString());
                            handleTransaction("deposit", Math.min(Number(e.target.value), (selectedAsset?.walletsdValue ?? 0)))
                        }}
                    />
                    <HStack alignContent={"right"} width={"100%"} justifyContent={"right"}>
                        <Button
                            onClick={() => { setTransactionValue(selectedAsset?.walletsdValue.toFixed(2) ?? "0"); handleTransaction("deposit", selectedAsset?.walletsdValue ?? 0) }}
                            width="10%" variant="unstyled" fontWeight="normal"
                        >
                            <Text
                                variant="body"
                                justifySelf={"center"}
                                textTransform="none"
                                fontSize="sm"
                                letterSpacing="1px"
                                display="flex">
                                max
                            </Text>
                        </Button>
                    </HStack></>}
                {/* On click, ossify the current deposit asset & open a new deposit section */}
                {selectedAsset && assetsWithOptions && assetsWithOptions.length > 1 && <Button
                    alignSelf="center"
                    onClick={() => { setOssifiedDeposits([...ossifiedDeposits, { ...selectedAsset, amountValue: transactionValue, txType: "deposit" }]); setSelectedAsset(undefined); setTransactionValue(""); }}
                    width={"fit-content"}
                    isDisabled={Number(transactionValue) === 0}
                    fontFamily="Inter"
                    fontWeight={"500"}
                    background={"transparent"}
                >
                    Add Another Asset
                </Button>}
            </Stack>

        </Stack>
    )
}