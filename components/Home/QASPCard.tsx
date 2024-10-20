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
import ConfirmModal from "../ConfirmModal"
import { QASummary } from "./QASummary"
import { GrPowerReset } from "react-icons/gr"

const ActSlider = React.memo(() => {
    const { quickActionState, setQuickActionState } = useQuickActionState()
    const earnCDTAsset = useAssetBySymbol('earnCDT')
    const earnCDTBalance = useBalanceByAsset(earnCDTAsset)??"1"
    const cdtAsset = useAssetBySymbol('CDT')
    const cdtBalance = useBalanceByAsset(cdtAsset)
    
    //Set withdraw slider max to the total USDC deposit, not the looped VT deposit
    const { data } = useCDTVaultTokenUnderlying(shiftDigits(earnCDTBalance, 6).toFixed(0))
    const underlyingCDT = shiftDigits(data, -6).toString() ?? "1"
    ////////////////////////////////////

    const { action: autoSP } = useAutoSP();

    const logo = useMemo(() => {return cdtAsset?.logo}, [cdtAsset])
    console.log("cdtAsset logo", logo)

    const totalBalance = useMemo(() => {
      return num(underlyingCDT).plus(cdtBalance).toString()
    }, [cdtBalance, underlyingCDT])
    console.log("CDTs", cdtBalance, underlyingCDT, totalBalance)

    const pendingBalance = useMemo(() => {
      return num(underlyingCDT).plus(quickActionState.autoSPdeposit).minus(quickActionState.autoSPwithdrawal).toNumber()
    }, [underlyingCDT, quickActionState.autoSPdeposit, quickActionState.autoSPwithdrawal])
    //set amount label 
    const actingAmount = useMemo(()=> {
      return (quickActionState.autoSPdeposit > 0 ? quickActionState.autoSPdeposit : quickActionState.autoSPwithdrawal).toFixed(0)
    }, [quickActionState.autoSPdeposit, quickActionState.autoSPwithdrawal])
    

    const onSliderChange = (value: number) => {
      if (value > parseFloat(underlyingCDT)) {
        let diff = num(value).minus(underlyingCDT).toNumber()
        setQuickActionState({ autoSPdeposit: diff, autoSPwithdrawal: 0 })
        console.log("deposit", diff)
        
      } else if (value < parseFloat(underlyingCDT)) {
        let diff = num(underlyingCDT).minus(value).toNumber()
        setQuickActionState({ autoSPdeposit: 0, autoSPwithdrawal: diff })
        console.log("withdraw", diff)
      }

    }

    const onReset = () => {
      setQuickActionState({ autoSPdeposit: 0, autoSPwithdrawal: 0 })
    }

    return (
      <Stack gap="0">
        <HStack justifyContent="space-between">
          <Text variant="lable" textTransform="unset">
            CDT in Vault
          </Text>
          <HStack>
            <Text variant="value">${pendingBalance}</Text>
          </HStack>
        </HStack>
        <SliderWithState 
          value={num(underlyingCDT).minus(quickActionState.autoSPwithdrawal).plus(quickActionState.autoSPdeposit).toNumber()} 
          onChange={onSliderChange} 
          max={Number(totalBalance)} 
        />

        <Button variant="ghost" width={"10"} padding={0} leftIcon={<GrPowerReset />} onClick={onReset} />
        <HStack>
          <ConfirmModal 
            label={quickActionState.autoSPdeposit > 0 ? `Deposit ${actingAmount.toString()} CDT` : quickActionState.autoSPwithdrawal > 0 ?  `Withdraw ${actingAmount.toString()} CDT` : "Manage"} 
            action={autoSP} 
            isDisabled={Number(totalBalance) < 1 || pendingBalance === num(underlyingCDT).toNumber()}>
            <QASummary logo={logo}/>
          </ConfirmModal>
        </HStack>
      </Stack>
    )
});
          
const SPCard = () => {
    console.log("rendering SPCard")
    const { action: compound } = useSPCompound()
    useEstimatedAnnualInterest(false)
    const { data: assetPool } = useStabilityAssetPool()
    const { data: basket } = useBasket()

    const revenueDistributionThreshold = 50000000
    const percentToDistribution = useMemo(() => {
      if (!basket) return 0
      return num(basket?.pending_revenue).dividedBy(revenueDistributionThreshold).toNumber()

    }, [basket])

    const { bidState } = useBidState()

    return (
        <Card width={"33%"}>
          <Stack>             
            <Text variant="title" fontSize={"lg"} letterSpacing={"1px"} justifyContent={"center"} display="flex" >Earn CDT: {bidState.cdpExpectedAnnualRevenue ? num(bidState.cdpExpectedAnnualRevenue).dividedBy(assetPool?.credit_asset.amount || 1).multipliedBy(100).toFixed(1) + "%" : "loading..."} </Text>
            <Divider marginBottom={"3vh"}/> 
            <List spacing={3} styleType="disc" padding="6" paddingTop="0">
              <ListItem><a style={{fontWeight:"bold", color:"rgb(196, 69, 240)"}}>Yield:</a> Revenue & Compounded Liquidations</ListItem>
              <ListItem>Compounds over 10% Slippage = Capital Loss</ListItem>
              <ListItem>Max 1 Day Withdraw Time</ListItem>
            </List>
            <ActSlider />
            <Divider marginTop={"3vh"}/>           
            <Slider
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
            </TxButton>
          </Stack>
        </Card>
    )
}

export default SPCard