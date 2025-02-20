import { parseError } from "@/helpers/parseError"
import Select from '@/components/Select'
import { Stack, HStack, Input, Button, Text, Image, Card } from "@chakra-ui/react"
import useMintState from "./hooks/useMintState";
import { useEffect, useMemo, useState } from "react";
import { AssetWithBalance } from "./hooks/useCombinBalance";
import { getSummary } from "@/helpers/mint";
import { num } from "@/helpers/num";
import { MintInput } from "./MintInput";

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
        if (mintState.assets.length > 0 && assetsWithOptions?.[0] && (!selectedAsset || selectedAsset?.walletsdValue === 0)) {
            setSelectedAsset(assetsWithOptions?.[0]);
        }
    }, [assetsWithOptions]);

    //Handle Reset Button
    useEffect(() => {
        setTransactionValue("");
        setOssifiedDeposits([]);

    }, [mintState.reset]);


    const handleTransaction = (transactionType: string, transactionValue: number) => {
        console.log("transactionType", transactionType, transactionValue)
        if (!transactionType || transactionValue <= 0) return;

        let updatedAssets = mintState.assets.map((a) => {
            if (a.symbol !== selectedAsset?.symbol) return a;
            // console.log("asset made it thru", a)

            const sliderValue = transactionType === "deposit" ? Number(transactionValue) : -Number(transactionValue);

            const diffInUsd = num(selectedAsset.depositUsdValue).minus(sliderValue).toNumber()
            const newDeposit = num(selectedAsset.depositUsdValue).minus(diffInUsd).toNumber()
            const amountValue = num(diffInUsd).isGreaterThan(selectedAsset.depositUsdValue)
                ? newDeposit
                : -diffInUsd
            // console.log("asset stats", selectedAsset.depositUsdValue, sliderValue, diffInUsd, newDeposit, amountValue)
            const amount = num(amountValue).dividedBy(selectedAsset.price).dp(selectedAsset.decimal ?? 6).toNumber()
            //
            //
            return {
                ...selectedAsset,
                amount,
                amountValue,
                sliderValue,
            }
        });
        // console.log("updatedAssets", updatedAssets)

        const { summary, totalUsdValue } = getSummary(updatedAssets);
        setMintState({ assets: updatedAssets, summary, totalUsdValue });
    };

    const onChange = (value: AssetWithBalance) => {
        setSelectedAsset(value);
        setTransactionValue("");
    }

    console.log("selectedAsset", selectedAsset);

    //TODO:
    //- Make reset button work for ossified labels
    //- Make asset button correctly dynamic for deposits/withdraws & mint/repay combos
    //- Click to edit the ossified labeled assets

    //- Change all Mint lingo to Borrow (Tweet this)

    //- Place redemption card in a modal somewhere

    return (
        <Stack>
            <Stack>
                {(selectedAsset || (ossifiedDeposits && ossifiedDeposits.length > 0) || (mintState.newDebtAmount && mintState.newDebtAmount != 0)) && (
                    <Stack pt="4">
                        {((selectedAsset && Number(transactionValue) > 0) || (ossifiedDeposits && ossifiedDeposits.length > 0)) && (
                            <Text variant="title" textTransform="none" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
                                Depositing: &nbsp;
                                <Text as="span" color="white" fontWeight="400">
                                    {selectedAsset
                                        ? ossifiedDeposits
                                            .concat([{ ...selectedAsset, amountValue: transactionValue, txType: "deposit" }])
                                            .filter(asset => asset && asset.amountValue > 0 && asset.txType === "deposit")
                                            .map(asset => `${Number(asset.amountValue).toFixed(2)} ${asset.symbol}`)
                                            .join(", ")
                                        : ossifiedDeposits
                                            .filter(asset => asset && asset.amountValue > 0 && asset.txType === "deposit")
                                            .map(asset => `${Number(asset.amountValue).toFixed(2)} ${asset.symbol}`)
                                            .join(", ")
                                    }
                                </Text>
                            </Text>
                        )}

                        {mintState.newDebtAmount && mintState.newDebtAmount !== 0 && (
                            <Text variant="title" textTransform="none" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
                                Borrowing: &nbsp;<Text as="span" color="white" fontWeight="400">{mintState.newDebtAmount} CDT</Text>
                            </Text>
                        )}

                    </Stack>
                )}

                {assetsWithOptions && assetsWithOptions.length != 0 && <><div style={{ width: "20%", alignSelf: "center", marginTop: "3%" }}><Select options={assetsWithOptions} onChange={onChange} value={selectedAsset} /></div>
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
                            onClick={() => { setTransactionValue(selectedAsset?.walletsdValue.toString() ?? "0"); handleTransaction("deposit", selectedAsset?.walletsdValue ?? 0) }}
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
                {selectedAsset && assetsWithOptions && assetsWithOptions.length != 0 && <Button
                    alignSelf="center"
                    onClick={() => { setOssifiedDeposits([...ossifiedDeposits, { ...selectedAsset, amountValue: transactionValue, txType: "deposit" }]); setSelectedAsset(undefined); setTransactionValue(""); }}
                    width={"30%"}
                    isDisabled={Number(transactionValue) === 0}
                    fontFamily="Inter"
                    fontWeight={"500"}
                >
                    Add Another Asset
                </Button>}
            </Stack>

        </Stack>
    )
}