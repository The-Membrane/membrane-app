import { parseError } from "@/helpers/parseError"
import Select from '@/components/Select'
import { Stack, HStack, Input, Button, Text, Image } from "@chakra-ui/react"
import useMintState from "./hooks/useMintState";
import { useEffect, useMemo, useState } from "react";
import { AssetWithBalance } from "./hooks/useCombinBalance";
import { getSummary } from "@/helpers/mint";

export const InitialCDPDeposit = () => {


    const [transactionValue, setTransactionValue] = useState('');
    const { mintState, setMintState } = useMintState();

    const [selectedAsset, setSelectedAsset] = useState<AssetWithBalance | undefined>(undefined);


    const assetsWithOptions = mintState.assets
        ?.map((asset) => ({
            ...asset,
            value: asset?.symbol,
            label: asset?.symbol,
        }))

    useEffect(() => {
        if (mintState.assets.length > 0 && assetsWithOptions?.[0] && !selectedAsset) {
            setSelectedAsset(assetsWithOptions?.[0]);
        }
    }, [assetsWithOptions]);


    // const handleTransaction = (transactionType: string) => {
    //     if (!transactionType || parseFloat(transactionValue) <= 0) return;

    //     let updatedAssets = mintState.assets.map((a) => {
    //         if (a.symbol !== label) return a;

    //         const sliderValue = transactionType === "deposit" ? Number(transactionValue) : -Number(transactionValue);

    //         const diffInUsd = num(asset.depositUsdValue).minus(sliderValue).toNumber()
    //         const newDeposit = num(asset.depositUsdValue).minus(diffInUsd).toNumber()
    //         const amountValue = num(diffInUsd).isGreaterThan(asset.depositUsdValue)
    //             ? newDeposit
    //             : -diffInUsd
    //         const amount = num(amountValue).dividedBy(asset.price).dp(asset.decimal ?? 6).toNumber()
    //         //
    //         //
    //         return {
    //             ...asset,
    //             amount,
    //             amountValue,
    //             sliderValue,
    //         }
    //     });

    //     const { summary, totalUsdValue } = getSummary(updatedAssets);
    //     setMintState({ assets: updatedAssets, summary, totalUsdValue });
    // };

    const onChange = (value: AssetWithBalance) => {
        setSelectedAsset(value);
    }
    console.log("selectedAsset", selectedAsset)


    return (
        <Stack>
            <Stack>
                <div style={{ width: "20%", alignSelf: "center" }}><Select options={assetsWithOptions} onChange={onChange} value={selectedAsset} /></div>
                <HStack width="100%" justifyContent="left">
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
                    value={transactionValue}
                    max={selectedAsset?.walletsdValue}
                    onChange={(e) => { e.preventDefault(); setTransactionValue(e.target.value) }}
                />
                <HStack alignContent={"right"} width={"100%"} justifyContent={"right"}>
                    <Button
                        onClick={() => setTransactionValue(selectedAsset?.walletsdValue.toString() ?? "0")}
                        width="20%" variant="unstyled" fontWeight="normal"
                    >
                        <Text variant="body" justifySelf="end" textTransform="none" fontSize="sm" letterSpacing="1px" display="flex">
                            max
                        </Text>
                    </Button>
                </HStack>
            </Stack>


            {/* <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" width="100%">
                {parseError(quickActionState?.usdcMint.deposit > 0 && quickActionState?.usdcMint.mint > 20 && mint.simulate.isError ? mint.simulate.error?.message ?? "" : "")}
            </Text> */}

        </Stack>
    )
}