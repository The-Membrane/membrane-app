import { Card, Text, Stack, HStack, Input, Button, Slider, SliderTrack, SliderFilledTrack, List, ListItem } from "@chakra-ui/react"
import { TxButton } from "../TxButton"
import useSPCompound from "./hooks/useSPCompound"
import { useEffect, useMemo, useState } from "react"
import useStabilityAssetPool from "../Bid/hooks/useStabilityAssetPool"
import { isGreaterThanZero, num } from "@/helpers/num"
import { useBoundedCDTVaultTokenUnderlying, useBoundedCDTRealizedAPR, useEstimatedAnnualInterest, useBoundedTVL } from "../Earn/hooks/useEarnQueries"
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
import useBoundedManage from "./hooks/useRangeBoundLPManage"
import useRangeBoundLP from "./hooks/useRangeBoundLP"
import { getBestCLRange } from "@/services/osmosis"
import { LPJoinDate } from "@/config/defaults"

const ActSlider = React.memo(() => {
    const { quickActionState, setQuickActionState } = useQuickActionState()
    const boundCDTAsset = useAssetBySymbol('range-bound-CDT')
    const boundCDTBalance = useBalanceByAsset(boundCDTAsset)??"1"
    const cdtAsset = useAssetBySymbol('CDT')
    const cdtBalance = useBalanceByAsset(cdtAsset)
    
    //Set withdraw slider max to the total CDT deposit, not the VT deposit
    const { data } = useBoundedCDTVaultTokenUnderlying(shiftDigits(boundCDTBalance, 6).toFixed(0))
    const underlyingCDT = shiftDigits(data, -6).toString() ?? "1"
    ////////////////////////////////////

    const { action: rbLP } = useRangeBoundLP();

    const logo = useMemo(() => {return cdtAsset?.logo}, [cdtAsset])
    console.log("cdtAsset logo", logo)

    const totalBalance = useMemo(() => {
      return num(underlyingCDT).plus(cdtBalance).toString()
    }, [cdtBalance, underlyingCDT])

    const pendingBalance = useMemo(() => {
      return num(underlyingCDT).plus(quickActionState.rangeBoundLPdeposit).minus(quickActionState.rangeBoundLPwithdrawal).toNumber()
    }, [underlyingCDT, quickActionState.rangeBoundLPdeposit, quickActionState.rangeBoundLPwithdrawal])
    //set amount label 
    const actingAmount = useMemo(()=> {
      return (quickActionState.rangeBoundLPdeposit > 0 ? quickActionState.rangeBoundLPdeposit : quickActionState.rangeBoundLPwithdrawal).toFixed(0)
    }, [quickActionState.rangeBoundLPdeposit, quickActionState.rangeBoundLPwithdrawal])
    

    const onSliderChange = (value: number) => {
      if (value > parseFloat(underlyingCDT)) {
        let diff = num(value).minus(underlyingCDT).toNumber()
        setQuickActionState({ rangeBoundLPdeposit: diff, rangeBoundLPwithdrawal: 0 })
        console.log("deposit", diff)
        
      } else if (value < parseFloat(underlyingCDT)) {
        let diff = num(underlyingCDT).minus(value).toNumber()
        setQuickActionState({ rangeBoundLPdeposit: 0, rangeBoundLPwithdrawal: diff })
        console.log("withdraw", diff)
      }

    }

    const onReset = () => {
      setQuickActionState({ rangeBoundLPdeposit: 0, rangeBoundLPwithdrawal: 0 })
    }

    return (
      <Stack gap="0" borderWidth={"1px"} borderColor="rgb(226, 216, 218)" borderRadius={"2rem"}>
        <HStack justifyContent="space-between" padding={"4%"}>
          <Text variant="lable" textTransform="unset">
            CDT in Vault
          </Text>
          <HStack>
            <Text variant="value">${pendingBalance.toFixed(2)}</Text>
          </HStack>
        </HStack>
        <SliderWithState 
          color="#20d6ff"
          width="92%"
          padding="4%"
          value={num(underlyingCDT).minus(quickActionState.rangeBoundLPwithdrawal).plus(quickActionState.rangeBoundLPdeposit).toNumber()} 
          onChange={onSliderChange} 
          max={Number(totalBalance)} 
        />
        

        <HStack gap={0} padding="4%">
          <Button variant="ghost" width={"10"} padding={0} leftIcon={<GrPowerReset />} onClick={onReset} />
          <ConfirmModal 
            label={quickActionState.rangeBoundLPdeposit > 0 ? `Deposit ${actingAmount.toString()} CDT` : quickActionState.rangeBoundLPwithdrawal > 0 ?  `Withdraw ${actingAmount.toString()} CDT` : "Manage"} 
            action={rbLP} 
            isDisabled={Number(totalBalance) < 1 || pendingBalance === num(underlyingCDT).toNumber()}>
            <QASummary logo={logo}/>
          </ConfirmModal>
        </HStack>
      </Stack>
    )
});
          
const RangeBoundLPCard = () => {
    const { action: manage } = useBoundedManage()
    useEstimatedAnnualInterest(false)
    //Get total deposit tokens
    const { data: TVL } = useBoundedTVL()

    const { data: basket } = useBasket()
    const { data: realizedAPR } = useBoundedCDTRealizedAPR()  

    const revenueDistributionThreshold = 50000000
    const percentToDistribution = useMemo(() => {
      if (!basket) return 0
      return num(basket?.pending_revenue).dividedBy(revenueDistributionThreshold).toNumber()

    }, [basket])

    const { data: clRewardList } = getBestCLRange()
    const daysSinceDeposit = num(Date.now() - LPJoinDate.getTime()).dividedBy(1000).dividedBy(86400).toNumber()
    const rangeBoundAPR = useMemo(() => {
        //upperXlower & middle are just for logs rn
        if (!clRewardList) return { rangeBoundAPR: 0}

        const totalrewards = ( clRewardList[2].reward + clRewardList[3].reward + clRewardList[4].reward + clRewardList[10].reward + clRewardList[11].reward + clRewardList[12].reward) / 6
        return {
          rangeBoundAPR: totalrewards / 1000000 / daysSinceDeposit * 365
          ,
        }
    }, [clRewardList])
    console.log("rangeBoundAPR", rangeBoundAPR)

    const { bidState } = useBidState()
    const isDisabled = useMemo(() => {return manage?.simulate.isError || !manage?.simulate.data }, [manage?.simulate.isError, manage?.simulate.data])

    return (
        <Card width={"33%"} borderColor={""} borderWidth={3} padding={4}>
          <Stack>             
            <Text variant="title" fontSize={"lg"} letterSpacing={"1px"} justifyContent={"center"} display="flex" color="rgb(226, 216, 218)">Earn CDT</Text>
            <Stack>
              <Text variant="title" fontSize={"lg"} letterSpacing={"1px"} display="flex"><a style={{fontWeight:"bold", color:"#20d6ff"}}>{realizedAPR ? `${realizedAPR?.runningDuration.toString()}D` : "Real"} APY: &nbsp;</a> <a className="textShadow">{realizedAPR?.negative ? "-" : ""}{(realizedAPR && realizedAPR.apr) ? num(realizedAPR?.apr).times(100).toFixed(1) + "%" : "loading..."}</a></Text>
              <Text variant="title" fontSize={"lg"} letterSpacing={"1px"} display="flex"><a style={{fontWeight:"bold", color:"rgb(226, 216, 218)"}}>Estimated APR: &nbsp;</a>{bidState.cdpExpectedAnnualRevenue ? num(bidState.cdpExpectedAnnualRevenue).dividedBy(TVL || 1).multipliedBy(100).toFixed(1) + "%" : "loading..."}</Text>
            </Stack>
            <Divider marginBottom={"3vh"}/> 
            <List spacing={3} styleType="disc" padding="6" paddingTop="0">
              <ListItem><a style={{fontWeight:"bold", color:"#20d6ff"}}>Yield:</a> Revenue & Swap Fees</ListItem>
              <ListItem>Withdraw Period: 0 days</ListItem>
            </List>
            <ActSlider />
            <Divider marginTop={"3"} marginBottom={"3"}/>           
            <Slider
              defaultValue={percentToDistribution}
              isReadOnly
              cursor="default"
              min={0}
              max={1}
              value={percentToDistribution}
            >
              <SliderTrack h="1.5">
                <SliderFilledTrack bg={'#20d6ff'} />
              </SliderTrack>
            </Slider>
            <TxButton
              maxW="100%"
              isLoading={manage?.simulate.isLoading || manage?.tx.isPending}
              isDisabled={isDisabled}
              onClick={() => manage?.tx.mutate()}
              toggleConnectLabel={false}
              style={{ alignSelf: "center" }}
            >
              {isDisabled && percentToDistribution >= 1 ? "Next Repayment Pays to LPs" : "Manage"}
            </TxButton>
          </Stack>
        </Card>
    )
}

export default RangeBoundLPCard