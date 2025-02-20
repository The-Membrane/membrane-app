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
        if (mintState.assets.length > 0 && assetsWithOptions?.[0] && !selectedAsset) {
            setSelectedAsset(assetsWithOptions?.[0]);
        }
    }, [assetsWithOptions]);

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
    //- Add per asset Max limiter to input
    //- Make reset button work for ossified labels
    //- Make asset button correctly dynamic for deposits/withdraws & mint/repay combos
    //- Click to edit the ossified labeled assets

    //- Change all Mint lingo to Borrow (Tweet this)

    //- Place redemption card in a modal somewhere

    return (
        <Stack>
            <Stack>
                {ossifiedDeposits && ossifiedDeposits.length > 0 && (
                    <Stack>
                        <Text variant="title" textTransform="none" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
                            Depositing {ossifiedDeposits
                                .filter(asset => asset && asset.amountValue > 0 && asset.txType === "deposit")
                                .map(asset => `${Number(asset.amountValue).toFixed(2)} ${asset.symbol}`)
                                .join(", ")}
                        </Text>
                    </Stack>
                )}

                {assetsWithOptions && assetsWithOptions.length != 0 && <><div style={{ width: "20%", alignSelf: "center" }}><Select options={assetsWithOptions} onChange={onChange} value={selectedAsset} /></div>
                    <HStack mt="5%" width="100%" justifyContent="left">
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
                        value={Number(transactionValue).toFixed(2)}
                        max={selectedAsset?.walletsdValue}
                        onChange={(e) => { e.preventDefault(); setTransactionValue(e.target.value); handleTransaction("deposit", Number(e.target.value)) }}
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