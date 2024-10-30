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
import useLPState from "../Mint/hooks/useLPState"
import { useOraclePrice } from "@/hooks/useOracle"
import useLP from "../Mint/hooks/useLP"
import { getBestCLRange } from "@/services/osmosis"
import { LPJoinDate } from "@/config/defaults"

const ActSlider = React.memo(({ range } : { range: string }) => {
    const cdt = useAssetBySymbol('CDT')
    const cdtBalance = useBalanceByAsset(cdt)
    const { LPState, setLPState } = useLPState()
    const { data: prices } = useOraclePrice()
    const logo = useMemo(() => {return cdt?.logo}, [cdt])
    const cdtPrice = prices?.find((price) => price.denom === cdt?.base)
    


    const txSuccess = () => {
      setLPState({ newCDT: 0})
    }
    const LP = useLP({ txSuccess })
    console.log("LP", LP.simulate.data, LP.tx.error, LP.tx.isError)

    const onSliderChange = (value: number) => {
        setLPState({ ...LPState, newCDT: value})
    }

    const onReset = () => {
      setLPState({ newCDT: 0 })
    }

    return (
      <Stack gap="0" borderWidth={"1px"} borderColor="rgb(226, 216, 218)" borderRadius={"2rem"}>
        <HStack justifyContent="space-between" padding={"4%"}>
          <Text variant="lable" textTransform="unset">
            CDT to LP
          </Text>
          <HStack>
            <Text variant="value">${LPState.newCDT.toFixed(2)}</Text>
          </HStack>
        </HStack>
        <SliderWithState
          color="#20d6ff"
          width="92%"
          padding="4%"
          value={num(LPState.newCDT).toNumber()} 
          onChange={onSliderChange} 
          max={Number(cdtBalance)} 
        />
        

        <HStack gap={0} padding="4%">
          <Button variant="ghost" width={"10"} padding={0} leftIcon={<GrPowerReset />} onClick={onReset} />
          <ConfirmModal 
            label={`LP into Range ${range}`} 
            action={LP} 
            isDisabled={Number(cdtBalance) < 1}>
            <QASummary logo={logo}/>
          </ConfirmModal>
        </HStack>
      </Stack>
    )
});
          
const LPCard = () => {
    // const { earnState, setEarnState } = useEarnState()
    // const earnUSDCAsset = useAssetBySymbol('earnUSDC')
    // const earnUSDCBalance = useBalanceByAsset(earnUSDCAsset)??"1"
    
    // //Set withdraw slider max to the total USDC deposit, not the looped VT deposit
    // const { data } = useUSDCVaultTokenUnderlying(shiftDigits(earnUSDCBalance, 6).toFixed(0))
    // const underlyingUSDC = shiftDigits(data, -6).toString() ?? "1"
    // ////////////////////////////////////
    
    // const pendingBalance = useMemo(() => {
    //   return num(underlyingUSDC).plus(earnState.deposit).minus(earnState.withdraw).toNumber()
    // }, [underlyingUSDC, earnState.deposit, earnState.withdraw])

      
    // const { data: realizedAPR } = useEarnUSDCRealizedAPR()  
    // const { data: vaultInfo } = useVaultInfo()
    // const { data: APRs } = useEarnUSDCEstimatedAPR() 
    // const APRObject = useMemo(() => {
    //   if (!APRs) return {
    //     weekly: "N/A",
    //     monthly: "N/A",
    //     three_month: "N/A",
    //     yearly: "N/A",
    //   }
    //   return {
    //     weekly: APRs.week_apr ? num(APRs?.week_apr).minus(num(vaultInfo?.cost)).times(vaultInfo?.leverage??1).multipliedBy(100).toFixed(1) : "N/A",
    //     monthly: APRs.month_apr ? num(APRs?.month_apr).minus(num(vaultInfo?.cost)).times(vaultInfo?.leverage??1).multipliedBy(100).toFixed(1) : "N/A",
    //     three_month: APRs.three_month_apr ? num(APRs?.three_month_apr).minus(num(vaultInfo?.cost)).times(vaultInfo?.leverage??1).multipliedBy(100).toFixed(1) : "N/A",
    //     yearly: APRs.year_apr ? num(APRs?.year_apr).minus(num(vaultInfo?.cost)).times(vaultInfo?.leverage??1).multipliedBy(100).toFixed(1) : "N/A",
    //   }
    // }, [APRs, vaultInfo])
    // const { longestAPR } = useMemo(() => {
    //   if (!APRObject) return { longestAPR: "0" }
    //   if (APRObject.yearly && APRObject.yearly != "N/A") return { longestAPR: APRObject.yearly }
    //   if (APRObject.three_month && APRObject.three_month != "N/A") return { longestAPR: APRObject.three_month }
    //   if (APRObject.monthly && APRObject.monthly != "N/A") return { longestAPR: APRObject.monthly }
    //   return { longestAPR: APRObject.weekly }
    // }, [APRObject])

    // const isDisabled = useMemo(() => {return compound?.simulate.isError || !compound?.simulate.data }, [compound?.simulate.isError, compound?.simulate.data])

    const daysSinceDeposit = num(Date.now() - LPJoinDate.getTime()).dividedBy(1000).dividedBy(86400).toNumber()
    console.log("days", (Date.now()), LPJoinDate.getTime() )
    
    const { data: clRewardList } = getBestCLRange()
    const rangeOptions = useMemo(() => {
        if (!clRewardList) return { lowerAggressive: 0, upperAggressive: 0, fullRange: 0 }
        return {
            lowerAggressive: (clRewardList[0].reward + clRewardList[1].reward + clRewardList[2].reward + clRewardList[3].reward + clRewardList[4].reward) / 5,
            upperAggressive: (clRewardList[10].reward + clRewardList[11].reward + clRewardList[12].reward + clRewardList[13].reward + clRewardList[14].reward) / 5,
            fullRange: clRewardList.slice(0,15).reduce((acc, curr) => acc + curr.reward, 0) / 15
        }
    }, [clRewardList])
    const highestAPR = useMemo(() => {
        if (!clRewardList) return {apr: 0, range: {lower: 0, upper: 0}, stringRange: "0-0"}
        if (rangeOptions.fullRange > rangeOptions.upperAggressive && rangeOptions.fullRange > rangeOptions.lowerAggressive) return {apr: rangeOptions.fullRange / 1000000 / daysSinceDeposit * 365, range: {lower: -200000, upper: -50000}, stringRange: "0.98-0.995"}
        if (rangeOptions.upperAggressive > rangeOptions.lowerAggressive && rangeOptions.upperAggressive > rangeOptions.fullRange) return {apr: rangeOptions.upperAggressive / 1000000 / daysSinceDeposit * 365, range: {lower: -100000, upper: -50000}, stringRange: "0.99-0.995"}
        return {apr: rangeOptions.lowerAggressive / 1000000 / daysSinceDeposit * 365, range: {lower: -200000, upper: -150000}, stringRange: "0.98-0.985"}
        
    }, [rangeOptions])
    console.log("highestAPR", highestAPR)

    return (
        <Card width={"33%"} borderColor={""} borderWidth={3} padding={4}>
          <Stack>             
            <Text variant="title" fontSize={"lg"} letterSpacing={"1px"} justifyContent={"center"} display="flex" color="rgb(226, 216, 218)">Earn BOTH</Text>
            <Stack>
                <Text variant="title" fontSize={"lg"} letterSpacing={"1px"} display="flex"><a style={{fontWeight:"bold", color:"#20d6ff"}}>{`${daysSinceDeposit.toFixed(0)}D`} APR: &nbsp;</a> <a className="textShadow">{num(highestAPR.apr).times(100).toFixed(1)}%</a></Text>
                <Text variant="title" fontSize={"lg"} letterSpacing={"1px"} display="flex" color="rgb(226, 216, 218)" > Best Range: {highestAPR.stringRange}</Text>
            </Stack>
            <Divider marginBottom={"3vh"}/> 
            <Text marginBottom={"4%"}><a style={{fontWeight:"bold", color:"#20d6ff", padding:"6", paddingTop:"0"}}>Yield:</a> LP in the Highest APR range to date</Text>
            <ActSlider range={highestAPR.stringRange}/>
            <Divider marginTop={"3vh"}/> 
          </Stack>
        </Card>
    )
}

export default LPCard