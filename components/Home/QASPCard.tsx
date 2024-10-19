import { Card, Text, Stack, HStack, Input, Button, Slider, SliderTrack, SliderFilledTrack, List, ListItem } from "@chakra-ui/react"
import { TxButton } from "../TxButton"
import useSPCompound from "./hooks/useSPCompound"
import { useEffect, useMemo, useState } from "react"
import useStabilityAssetPool from "../Bid/hooks/useStabilityAssetPool"
import { isGreaterThanZero, num } from "@/helpers/num"
import { useCDTVaultTokenUnderlying, useEstimatedAnnualInterest } from "../Earn/hooks/useEarnQueries"
import useBidState from "../Bid/hooks/useBidState"
import useQuickActionState from "./hooks/useQuickActionState"
import { useAssetBySymbol } from "@/hooks/useAssets"
import { useBalanceByAsset } from "@/hooks/useBalance"
import ActModal from "../Earn/ActModal"
import { SliderWithState } from "../Mint/SliderWithState"
import { shiftDigits } from "@/helpers/math"
import useAutoSP from "./hooks/useAutoSP"
import { useBasket } from "@/hooks/useCDP"
import Divider from "../Divider"
import React from "react"


const DepositButton = () => {
  const { quickActionState, setQuickActionState } = useQuickActionState()
  const cdtAsset = useAssetBySymbol('CDT')
  const cdtBalance = useBalanceByAsset(cdtAsset)

  const { action: autoSP } = useAutoSP()

  const onSliderChange = (value: number) => {
    setQuickActionState({ autoSPdeposit: value, autoSPwithdrawal: 0 })
  }

  return (
    <ActModal
      width="100%"
      label="Deposit"
      isDisabled={!isGreaterThanZero(cdtBalance)}
      action={autoSP}
    >
      
      <Stack gap="0">
        <HStack justifyContent="space-between">
          <Text variant="lable" textTransform="unset">
            CDT
          </Text>
          <HStack>
            <Text variant="value">${quickActionState.autoSPdeposit}</Text>
          </HStack>
        </HStack>
        <SliderWithState value={quickActionState.autoSPdeposit} onChange={onSliderChange} min={0} max={parseFloat(cdtBalance)} walletCDT={1} summary={["empty"]}/>
      </Stack>
    </ActModal>
  )
}

const WithdrawButton = React.memo(() => {
    const { quickActionState, setQuickActionState } = useQuickActionState()
    const earnCDTAsset = useAssetBySymbol('earnCDT')
    const earnCDTBalance = useBalanceByAsset(earnCDTAsset)??"1"
    
    //Set withdraw slider max to the total USDC deposit, not the looped VT deposit
    const { data } = useCDTVaultTokenUnderlying(shiftDigits(1, 6).toFixed(0))
    const underlyingCDT = data ?? "1"
    ////////////////////////////////////

    const { action: autoSP } = useAutoSP(underlyingCDT);


    const onSliderChange = (value: number) => {      
      setQuickActionState({ autoSPwithdrawal: value, autoSPdeposit: 0 })    
    }

    return (
      <ActModal
        width="100%"
        label="Withdraw"
        isDisabled={!isGreaterThanZero(underlyingCDT)}
        action={autoSP}
      >
      <Stack gap="0">
        <HStack justifyContent="space-between">
          <Text variant="lable" textTransform="unset">
            CDT
          </Text>
          <HStack>
            <Text variant="value">${quickActionState.autoSPwithdrawal}</Text>
          </HStack>
        </HStack>
        <SliderWithState value={quickActionState.autoSPwithdrawal} onChange={onSliderChange} min={0} max={shiftDigits(underlyingCDT??1, -6).toNumber()} walletCDT={1} summary={["empty"]}/>
      </Stack>
      </ActModal>
    )
});
          
const SPCard = () => {
    console.log("rendering SPCard")
    // const { action: compound } = useSPCompound()
    // useEstimatedAnnualInterest(false)
    // const { data: assetPool } = useStabilityAssetPool()
    // const { data: basket } = useBasket()

    // const revenueDistributionThreshold = 50000000
    // const percentToDistribution = useMemo(() => {
    //   if (!basket) return 0
    //   return num(basket?.pending_revenue).dividedBy(revenueDistributionThreshold).toNumber()

    // }, [basket])

    // const { bidState } = useBidState()

    return (
        <Card width={"33%"}>
          <Stack>             
            {/* <Text variant="title" fontSize={"lg"} letterSpacing={"1px"} justifyContent={"center"} display="flex" >Earn CDT: {bidState.cdpExpectedAnnualRevenue ? num(bidState.cdpExpectedAnnualRevenue).dividedBy(assetPool?.credit_asset.amount || 1).multipliedBy(100).toFixed(1) + "%" : "loading..."} </Text> */}
            <Divider marginBottom={"3vh"}/> 
            <List spacing={3} styleType="disc" padding="6" paddingTop="0">
              <ListItem><a style={{fontWeight:"bold", color:"rgb(196, 69, 240)"}}>Yield:</a> Revenue & Compounded Liquidations</ListItem>
              <ListItem>Compounds over 10% Slippage = Capital Loss</ListItem>
              <ListItem>Max 1 Day Withdraw Time</ListItem>
            </List>
            {/* <DepositButton /> */}
            <WithdrawButton />
              {/* <HStack>
                <Stack py="5" w="full" gap="3" mb={"0"} >
                <Text variant="body"> Max CDT to Loop </Text>
                <HStack>
                    <Input 
                      width={"40%"} 
                      textAlign={"center"} 
                      placeholder="0" 
                      type="number" 
                      value={earnState.loopMax ?? 0} 
                      onChange={handleInputChange}
                    />
                    <TxButton
                      maxW="75px"
                      isLoading={loop?.simulate.isLoading || loop?.tx.isPending}
                      isDisabled={loop?.simulate.isError || !loop?.simulate.data}
                      onClick={() => loop?.tx.mutate()}
                      toggleConnectLabel={false}
                      style={{ alignSelf: "end" }}
                    >
                      Loop
                    </TxButton>
                </HStack>
                </Stack>
              </HStack>            
              <HStack>
                <Stack py="5" w="full" gap="3" mb={"0"} >
                <Text variant="body"> Did you buy CDT {`<= $`}{num(basket?.credit_price.price??"0").multipliedBy(0.985).toFixed(3)}?</Text>
                <HStack>
                    <Input 
                      width={"40%"} 
                      textAlign={"center"} 
                      placeholder="0" 
                      type="number" 
                      value={earnState.redeemAmount ?? 0} 
                      max={CDTBalance}
                      onChange={handleRedeemInputChange}
                    />
                    <TxButton
                      maxW="75px"
                      isLoading={redeem?.simulate.isLoading || redeem?.tx.isPending}
                      isDisabled={redeem?.simulate.isError || !redeem?.simulate.data}
                      onClick={() => redeem?.tx.mutate()}
                      toggleConnectLabel={false}
                      style={{ alignSelf: "end" }}
                    >
                      Redeem
                    </TxButton>
                  </HStack>
                </Stack>
              </HStack>     */}
            <Divider marginTop={"3vh"}/>           
            {/* <Slider
              defaultValue={percentToDistribution}
              isReadOnly
              cursor="default"
              min={0}
              max={1}
              value={percentToDistribution}
            >
              <SliderTrack h="1.5">
                <SliderFilledTrack bg={'blue.400'} />
              </SliderTrack>
            </Slider>
            <TxButton
              maxW="100%"
              isLoading={compound?.simulate.isLoading || compound?.tx.isPending}
              isDisabled={compound?.simulate.isError || !compound?.simulate.data}
              onClick={() => compound?.tx.mutate()}
              toggleConnectLabel={false}
              style={{ alignSelf: "center" }}
            >
              Compound
            </TxButton> */}
          </Stack>
        </Card>
    )
}

export default SPCard