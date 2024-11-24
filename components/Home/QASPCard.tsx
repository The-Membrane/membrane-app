import { Card, Text, Stack, HStack, Input, Button, Slider, SliderTrack, SliderFilledTrack, List, ListItem } from "@chakra-ui/react"
import { TxButton } from "../TxButton"
import useSPCompound from "./hooks/useSPCompound"
import { useEffect, useMemo, useState } from "react"
import useStabilityAssetPool from "../Bid/hooks/useStabilityAssetPool"
import { isGreaterThanZero, num } from "@/helpers/num"
import { useCDTVaultTokenUnderlying, useEarnCDTRealizedAPR, useEstimatedAnnualInterest } from "../Earn/hooks/useEarnQueries"
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
      <Stack gap="0" borderWidth={"1px"} borderColor="rgb(226, 216, 218)" borderRadius={"2rem"}>
        <HStack justifyContent="space-between" padding={"4%"}>
          <Text fontSize="lg" fontFamily="Inter" variant="lable" textTransform="unset">
            CDT in Vault
          </Text>
          <HStack>
            <Text fontFamily="Inter" variant="value">${pendingBalance.toFixed(2)}</Text>
          </HStack>
        </HStack>
        <SliderWithState 
          color="#20d6ff"
          width="92%"
          padding="4%"
          value={num(underlyingCDT).minus(quickActionState.autoSPwithdrawal).plus(quickActionState.autoSPdeposit).toNumber()} 
          onChange={onSliderChange} 
          max={Number(totalBalance)} 
        />
        

        <HStack gap={0} padding="4%">
          <Button variant="ghost" width={"10"} padding={0} leftIcon={<GrPowerReset />} onClick={onReset} />
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
          
const SPCard = ({width = "33%", title= "Liquidate CDT"}: {width?: string, title?: string}) => {
    const { action: compound } = useSPCompound()
    // useEstimatedAnnualInterest(false)
    // const { data: assetPool } = useStabilityAssetPool()
    const { data: realizedAPR } = useEarnCDTRealizedAPR()  


    // const { bidState } = useBidState()
    const isDisabled = useMemo(() => {return compound?.simulate.isError || !compound?.simulate.data }, [compound?.simulate.isError, compound?.simulate.data])

    return (
        <Card width={width} borderColor={""} borderWidth={3} padding={4}>
          <Stack>             
            <Text fontFamily="Inter" variant="title" fontSize={"lg"} letterSpacing={"1px"} justifyContent={"center"} display="flex" color="rgb(226, 216, 218)">{title}</Text>
            <Stack>
              <Text fontFamily="Inter" variant="title" fontSize={"lg"} letterSpacing={"1px"} display="flex"><a style={{fontWeight:"bold", color:"#20d6ff"}}>{realizedAPR ? `${realizedAPR?.runningDuration.toString()}D` : "Real"} APY: &nbsp;</a> <a className="textShadow">{realizedAPR?.negative ? "-" : ""}{(realizedAPR && realizedAPR.apr) ? num(realizedAPR?.apr).times(100).toFixed(1) + "%" : "loading..."}</a></Text>
              <Text fontFamily="Inter" variant="title" fontSize={"lg"} letterSpacing={"1px"} display="flex"><a style={{fontWeight:"bold", color:"rgb(226, 216, 218)"}}>Estimated APR: N/A</a></Text>
            </Stack>
            <Divider marginBottom={"3vh"}/> 
            <List spacing={3} styleType="disc" padding="6" paddingTop="0">
              <ListItem fontFamily="Inter" fontSize="md"><a style={{fontWeight:"bold", color:"#20d6ff"}}>Yield:</a> Compounded Liquidations (no longer gets revenue)</ListItem>
              <ListItem fontFamily="Inter" fontSize="md">Compounds over 10% Slippage = <a style={{fontWeight:"bold", color:"rgb(231, 58, 58)"}}>Capital Loss</a> </ListItem>
              <ListItem fontFamily="Inter" fontSize="md">Minimum Deposit: 6 CDT</ListItem>
            </List>
            <ActSlider />
            <Divider marginTop={"3"} marginBottom={"3"}/>       
            <TxButton
              maxW="100%"
              isLoading={compound?.simulate.isLoading || compound?.tx.isPending}
              isDisabled={isDisabled}
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