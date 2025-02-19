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
    }, [mintState.reset]);


    const handleTransaction = (transactionType: string, transactionValue: number) => {
        if (!transactionType || transactionValue <= 0) return;

        let updatedAssets = mintState.assets.map((a) => {
            if (a.symbol !== selectedAsset?.symbol) return a;

            const sliderValue = transactionType === "deposit" ? Number(transactionValue) : -Number(transactionValue);

            const diffInUsd = num(selectedAsset.depositUsdValue).minus(sliderValue).toNumber()
            const newDeposit = num(selectedAsset.depositUsdValue).minus(diffInUsd).toNumber()
            const amountValue = num(diffInUsd).isGreaterThan(selectedAsset.depositUsdValue)
                ? newDeposit
                : -diffInUsd
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

        const { summary, totalUsdValue } = getSummary(updatedAssets);
        setMintState({ assets: updatedAssets, summary, totalUsdValue });
    };

    const onChange = (value: AssetWithBalance) => {
        setSelectedAsset(value);
        setTransactionValue("");
    }

    //TODO:
    //- Create Add Asset that converts the current action into a label with an Edit button above the new action


    //- Remove redemption card & swap it into a action queue list
    //- Place redemption card in a modal somewhere

    return (
        <Stack>
            <Stack>
                {ossifiedDeposits.map((asset) => {
                    if (!asset || asset.sliderValue === 0) return null;
                    return (
                        <Card width="80%" boxShadow={"0 0 25px rgba(90, 90, 90, 0.5)"} >
                            <HStack>
                                <Text variant="title" textTransform={"none"} textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
                                    Depositing {asset.sliderValue} {asset?.symbol}
                                </Text>
                            </HStack>
                            {/* <MintInput
                                asset={asset}
                                handleTransaction={handleTransaction}
                                transactionValue={transactionValue}
                                setTransactionValue={setTransactionValue}
                            /> */}
                        </Card>
                    )
                })}
                <div style={{ width: "20%", alignSelf: "center" }}><Select options={assetsWithOptions} onChange={onChange} value={selectedAsset} /></div>
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
                </HStack>
                {/* On click, ossify the current deposit asset & open a new deposit section */}
                {selectedAsset && assetsWithOptions.length != 0 && <Button
                    alignSelf="center"
                    onClick={() => { setOssifiedDeposits([...ossifiedDeposits, selectedAsset]); setSelectedAsset(undefined) }}
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