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
import useAutoSPEnter from "./hooks/useAutoSPEnter"
import useAutoSPExit from "./hooks/useAutoSPExit"
import { useBasket } from "@/hooks/useCDP"
import Divider from "../Divider"


const DepositButton = () => {
  const { quickActionState, setQuickActionState } = useQuickActionState()
  const cdtAsset = useAssetBySymbol('CDT')
  const cdtBalance = useBalanceByAsset(cdtAsset)

  const { action: autoSPenter } = useAutoSPEnter()

  const onSliderChange = (value: number) => {
    setQuickActionState({ autoSPdeposit: value })
  }

  return (
    <ActModal
      width="100%"
      label="Deposit"
      isDisabled={!isGreaterThanZero(cdtBalance)}
      action={autoSPenter}
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

const WithdrawButton = () => {
    const [withdraw, setWithdraw] = useState<number>(0)
    const { quickActionState, setQuickActionState } = useQuickActionState()
    const earnCDTAsset = useAssetBySymbol('earnCDT')
    const earnCDTBalance = useBalanceByAsset(earnCDTAsset)
    const { action: autoSPexit } = useAutoSPExit()

    //Set withdraw slider max to the total USDC deposit, not the looped VT deposit
    const { data: underlyingCDT } = useCDTVaultTokenUnderlying(shiftDigits(earnCDTBalance, 6).toFixed(0))
    ////////////////////////////////////

    const vttoCDTRatio = useMemo(() => { return num(earnCDTBalance).dividedBy(num(underlyingCDT??1)) }, [earnCDTBalance, underlyingCDT])   

    const onSliderChange = (value: number) => {      
      setWithdraw(value)
    }

    useEffect(() => {      
      // if (!withdraw) return
      ////Convert the CDT amount to the earnCDT amount using the queried ratio///
      const vtAmount = num(shiftDigits(withdraw, 6)).times(vttoCDTRatio)
      setQuickActionState({ autoSPwithdrawal: num(vtAmount.toFixed(0)).toNumber() })
    }, [withdraw])

    return (
      <ActModal
        width="100%"
        label="Withdraw"
        isDisabled={!isGreaterThanZero(underlyingCDT)}
        action={autoSPexit}
      >
      <Stack gap="0">
        <HStack justifyContent="space-between">
          <Text variant="lable" textTransform="unset">
            USDC
          </Text>
          <HStack>
            <Text variant="value">${withdraw}</Text>
          </HStack>
        </HStack>
        <SliderWithState value={withdraw} onChange={onSliderChange} min={0} max={shiftDigits(underlyingCDT??1, -6).toNumber()} walletCDT={1} summary={["empty"]}/>
      </Stack>
      </ActModal>
    )
}
          
const SPCard = () => {
    const { action: compound } = useSPCompound()
    const { data: revenue } = useEstimatedAnnualInterest(false)
    const { data: assetPool } = useStabilityAssetPool()
    const { data: basket } = useBasket()

    const revenueDistributionThreshold = 50000000
  //  console.log("basket revenue", num(basket?.pending_revenue).dividedBy(revenueDistributionThreshold).toNumber(), basket?.pending_revenue, revenueDistributionThreshold)
    const percentToDistribution = useMemo(() => {
      if (!basket) return 0
      return num(basket?.pending_revenue).dividedBy(revenueDistributionThreshold).toNumber()

    }, [basket])


    const { bidState } = useBidState()

    const stabilityPoolAPR = useMemo(() => {
      if (revenue && assetPool) {
  
          return num(revenue.totalExpectedRevenue).dividedBy(assetPool.credit_asset.amount).multipliedBy(100).toFixed(1) + "%"
      } else console.log("none of one", revenue, assetPool)
    }, [revenue, assetPool])

    return (
        <Card width={"33%"}>
          <Stack>             
            <Text variant="title" fontSize={"lg"} letterSpacing={"1px"} justifyContent={"center"} display="flex" >Earn CDT: {bidState.cdpExpectedAnnualRevenue ? stabilityPoolAPR : "loading..."} </Text>
            <Divider marginBottom={"3vh"}/> 
            <List spacing={3} styleType="disc">
              <ListItem>First item</ListItem>
              <ListItem>Second item</ListItem>
              <ListItem>Third item</ListItem>
            </List>
            <DepositButton />
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
            {/* Compound normal SP Button*/}
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