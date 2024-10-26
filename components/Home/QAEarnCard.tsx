import { Card, Text, Stack, HStack, Input, Button, Slider, SliderTrack, SliderFilledTrack, List, ListItem } from "@chakra-ui/react"
import { TxButton } from "../TxButton"
import useSPCompound from "./hooks/useSPCompound"
import { useEffect, useMemo, useState } from "react"
import useStabilityAssetPool from "../Bid/hooks/useStabilityAssetPool"
import { isGreaterThanZero, num } from "@/helpers/num"
import { useUSDCVaultTokenUnderlying, useEstimatedAnnualInterest, useVaultInfo, useEarnUSDCEstimatedAPR, useEarnUSDCRealizedAPR } from "../Earn/hooks/useEarnQueries"
import useBidState from "../Bid/hooks/useBidState"
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
import useEarnState from "../Earn/hooks/useEarnState"
import useEarn from "../Earn/hooks/useEarn"

const ActSlider = React.memo(() => {
    const { earnState, setEarnState } = useEarnState()
    const earnUSDCAsset = useAssetBySymbol('earnUSDC')
    const earnUSDCBalance = useBalanceByAsset(earnUSDCAsset)??"1"
    const USDCAsset = useAssetBySymbol('USDC')
    const USDCBalance = useBalanceByAsset(USDCAsset)
    
    //Set withdraw slider max to the total USDC deposit, not the looped VT deposit
    const { data } = useUSDCVaultTokenUnderlying(shiftDigits(earnUSDCBalance, 6).toFixed(0))
    const underlyingUSDC = shiftDigits(data, -6).toString() ?? "1"
    ////////////////////////////////////

    const { action: earn } = useEarn();

    const logo = useMemo(() => {return USDCAsset?.logo}, [USDCAsset])
    console.log("USDCAsset logo", logo)

    const totalBalance = useMemo(() => {
      return num(underlyingUSDC).plus(USDCBalance).toString()
    }, [USDCBalance, underlyingUSDC])
    console.log("USDCs", USDCBalance, underlyingUSDC, totalBalance)

    const pendingBalance = useMemo(() => {
      return num(underlyingUSDC).plus(earnState.deposit).minus(earnState.withdraw).toNumber()
    }, [underlyingUSDC, earnState.deposit, earnState.withdraw])
    //set amount label 
    const actingAmount = useMemo(()=> {
      return (earnState.deposit > 0 ? earnState.deposit : earnState.withdraw).toFixed(0)
    }, [earnState.deposit, earnState.withdraw])
    

    const onSliderChange = (value: number) => {
      if (value > parseFloat(underlyingUSDC)) {
        let diff = num(value).minus(underlyingUSDC).toNumber()
        setEarnState({ deposit: diff, withdraw: 0 })
        console.log("deposit", diff)
        
      } else if (value < parseFloat(underlyingUSDC)) {
        let diff = num(underlyingUSDC).minus(value).toNumber()
        setEarnState({ deposit: 0, withdraw: diff })
        console.log("withdraw", diff)
      }

    }

    const onReset = () => {
      setEarnState({ deposit: 0, withdraw: 0 })
    }

    return (
      <Stack gap="0" borderWidth={"7px"} borderColor="rebeccapurple" borderRadius={"2rem"}>
        <HStack justifyContent="space-between" padding={"4%"}>
          <Text variant="lable" textTransform="unset">
            USDC in Vault
          </Text>
          <HStack>
            <Text variant="value">${pendingBalance.toFixed(2)}</Text>
          </HStack>
        </HStack>
        <SliderWithState 
          width="92%"
          padding="4%"
          value={num(underlyingUSDC).minus(earnState.withdraw).plus(earnState.deposit).toNumber()} 
          onChange={onSliderChange} 
          max={Number(totalBalance)} 
        />
        

        <HStack gap={0} padding="4%">
          <Button variant="ghost" width={"10"} padding={0} leftIcon={<GrPowerReset />} onClick={onReset} />
          <ConfirmModal 
            label={earnState.deposit > 0 ? `Deposit ${actingAmount.toString()} USDC` : earnState.withdraw > 0 ?  `Withdraw ${actingAmount.toString()} USDC` : "Manage"} 
            action={earn} 
            isDisabled={Number(totalBalance) < 1 || pendingBalance === num(underlyingUSDC).toNumber()}>
            <QASummary logo={logo}/>
          </ConfirmModal>
        </HStack>
      </Stack>
    )
});
          
const EarnCard = () => {
    const { earnState, setEarnState } = useEarnState()
    const earnUSDCAsset = useAssetBySymbol('earnUSDC')
    const earnUSDCBalance = useBalanceByAsset(earnUSDCAsset)??"1"
    
    //Set withdraw slider max to the total USDC deposit, not the looped VT deposit
    const { data } = useUSDCVaultTokenUnderlying(shiftDigits(earnUSDCBalance, 6).toFixed(0))
    const underlyingUSDC = shiftDigits(data, -6).toString() ?? "1"
    ////////////////////////////////////
    
    const pendingBalance = useMemo(() => {
      return num(underlyingUSDC).plus(earnState.deposit).minus(earnState.withdraw).toNumber()
    }, [underlyingUSDC, earnState.deposit, earnState.withdraw])

      
    const { data: realizedAPR } = useEarnUSDCRealizedAPR()  
    const { data: vaultInfo } = useVaultInfo()
    const { data: APRs } = useEarnUSDCEstimatedAPR() 
    const APRObject = useMemo(() => {
      if (!APRs) return {
        weekly: "N/A",
        monthly: "N/A",
        three_month: "N/A",
        yearly: "N/A",
      }
      return {
        weekly: APRs.week_apr ? num(APRs?.week_apr).minus(num(vaultInfo?.cost)).times(vaultInfo?.leverage??1).multipliedBy(100).toFixed(1) : "N/A",
        monthly: APRs.month_apr ? num(APRs?.month_apr).minus(num(vaultInfo?.cost)).times(vaultInfo?.leverage??1).multipliedBy(100).toFixed(1) : "N/A",
        three_month: APRs.three_month_apr ? num(APRs?.three_month_apr).minus(num(vaultInfo?.cost)).times(vaultInfo?.leverage??1).multipliedBy(100).toFixed(1) : "N/A",
        yearly: APRs.year_apr ? num(APRs?.year_apr).minus(num(vaultInfo?.cost)).times(vaultInfo?.leverage??1).multipliedBy(100).toFixed(1) : "N/A",
      }
    }, [APRs, vaultInfo])
    const { longestAPR } = useMemo(() => {
      if (!APRObject) return { longestAPR: "0" }
      if (APRObject.yearly && APRObject.yearly != "N/A") return { longestAPR: APRObject.yearly }
      if (APRObject.three_month && APRObject.three_month != "N/A") return { longestAPR: APRObject.three_month }
      if (APRObject.monthly && APRObject.monthly != "N/A") return { longestAPR: APRObject.monthly }
      return { longestAPR: APRObject.weekly }
    }, [APRObject])

    // const isDisabled = useMemo(() => {return compound?.simulate.isError || !compound?.simulate.data }, [compound?.simulate.isError, compound?.simulate.data])

    return (
        <Card width={"33%"} borderColor={""} borderWidth={3} padding={4}>
          <Stack>             
            <Text variant="title" fontSize={"lg"} letterSpacing={"1px"} justifyContent={"center"} display="flex" color="rgb(196, 69, 240)">Earn USDC</Text>
            <Stack>
                <Text variant="title" fontSize={"lg"} letterSpacing={"1px"} display="flex"><a style={{fontWeight:"bold", color:"rgb(196, 69, 240)"}}>{realizedAPR ? `${realizedAPR?.runningDuration.toString()}D` : "Real"} APR:</a> {realizedAPR?.negative ? "-" : ""}{(realizedAPR && realizedAPR.apr) ? num(realizedAPR?.apr).times(100).toFixed(1) : "N/A"}%</Text>
                <Text variant="title" fontSize={"lg"} letterSpacing={"1px"} display="flex"><a style={{fontWeight:"bold", color:"rgb(196, 69, 240)"}}>Estimated APR:</a> {longestAPR}%</Text>
            </Stack>
            <Divider marginBottom={"3vh"}/> 
            <List spacing={3} styleType="disc" padding="6" paddingTop="0">
              <ListItem><a style={{fontWeight:"bold", color:"rgb(196, 69, 240)"}}>Yield:</a> Revenue & Compounded Liquidations</ListItem>
              <ListItem>Max 1 Day Withdraw Time</ListItem>
              <ListItem>Compounds over 10% Slippage = Capital Loss</ListItem>
            </List>
            <ActSlider />
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
              isDisabled={isDisabled}
              onClick={() => compound?.tx.mutate()}
              toggleConnectLabel={false}
              style={{ alignSelf: "center" }}
            >
              {isDisabled && percentToDistribution >= 1 ? "Next Repayment Pays to Omni-Pool" : "Compound"}
            </TxButton> */}
          </Stack>
        </Card>
    )
}

export default EarnCard