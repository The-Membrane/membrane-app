import React, { use, useEffect, useMemo } from 'react'
import { Card, HStack, Stack, Text } from '@chakra-ui/react'
import { TxButton } from '@/components/TxButton'
import useStableYieldLoop from './hooks/useStableYieldLoop'
import { isGreaterThanZero, num } from '@/helpers/num'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import ActModal from './ActModal'
import useEarnState from './hooks/useEarnState'
import { useBasket, useBasketPositions, useCollateralInterest, useUserPositions } from '@/hooks/useCDP'
import { shiftDigits } from '@/helpers/math'
import { PositionResponse } from '@/contracts/codegen/positions/Positions.types'
import { Asset } from '@/helpers/chain'
import { useOraclePrice } from '@/hooks/useOracle'
import { Price } from '@/services/oracle'
import { SliderWithState } from '../Mint/SliderWithState'
import { getUnderlyingUSDC } from '@/services/earn'
import { useVaultTokenUnderlying, useAPR } from './hooks/useEarnQueries'
import useEarnExit from './hooks/useEarnExit'
import Divider from '../Divider'


const DepositButton = () => {
  const { earnState, setEarnState } = useEarnState()
  const usdcAsset = useAssetBySymbol('USDC')
  const usdcBalance = useBalanceByAsset(usdcAsset)

  const { action: stableLooping } = useStableYieldLoop()

  const onSliderChange = (value: number) => {
    setEarnState({ deposit: value })
  }

  return (
    <ActModal
      // px="5"
      // w="fit-content"
      // fontSize="sm"
      label="Deposit"
      isDisabled={!isGreaterThanZero(usdcBalance)}
      action={stableLooping}
    >
      
      <Stack gap="0">
        <HStack justifyContent="space-between">
          <Text variant="lable" textTransform="unset">
            USDC
          </Text>
          <HStack>
            <Text variant="value">${earnState.deposit}</Text>
          </HStack>
        </HStack>
        <SliderWithState value={earnState.deposit} onChange={onSliderChange} min={0} max={parseFloat(usdcBalance)} walletCDT={1} summary={["empty"]}/>
      </Stack>
    </ActModal>
  )
}

const WithdrawButton = () => {
    const { earnState, setEarnState } = useEarnState()    
    const loopedUSDCAsset = useAssetBySymbol('loopedMarsUSDC')
    const loopedUSDCBalance = useBalanceByAsset(loopedUSDCAsset)

    //Set withdraw slider max to the total USDC deposit, not the looped VT deposit
    const { data: underlyingUSDC } = useVaultTokenUnderlying(loopedUSDCBalance)
    ////////////////////////////////////

    const vttoUSDCRatio = useMemo(() => { return num(loopedUSDCBalance).dividedBy(num(underlyingUSDC)) }, [loopedUSDCBalance, underlyingUSDC])

    //Unloop to the withdrawal amount
    const { action: earnExit } = useEarnExit()

    const onSliderChange = (value: number) => {
      ////Convert the USDC amount to the looped USDC amount using the queried ratio///
      //Shift USDC amount back
      const vtAmount = num(shiftDigits(value, 6)).times(vttoUSDCRatio)

      setEarnState({ withdraw: vtAmount.toNumber() })
    }

    return (
      <ActModal
        // px="5"
        // w="fit-content"
        // fontSize="sm"
        label="Withdraw"
        isDisabled={!isGreaterThanZero(underlyingUSDC)}
        action={earnExit}
      >
      <Stack gap="0">
        <HStack justifyContent="space-between">
          <Text variant="lable" textTransform="unset">
            USDC
          </Text>
          <HStack>
            <Text variant="value">${earnState.deposit}</Text>
          </HStack>
        </HStack>
        <SliderWithState value={earnState.withdraw} onChange={onSliderChange} min={0} max={shiftDigits(underlyingUSDC, -6).toNumber()} walletCDT={1} summary={["empty"]}/>
      </Stack>
      </ActModal>
    )
}

const Deposit = () => {
  const { earnState } = useEarnState()
  const usdcAsset = useAssetBySymbol('USD')
  const { data: prices } = useOraclePrice()
  const usdcPrice = parseFloat(prices?.find((price) => price.denom === usdcAsset?.base)?.price ?? "0")
  
  const loopedUSDCAsset = useAssetBySymbol('loopedMarsUSDC')
  const loopedUSDCBalance = useBalanceByAsset(loopedUSDCAsset)
  const { data: underlyingUSDC } = useVaultTokenUnderlying(loopedUSDCBalance)
  
  const { data: APRs } = useAPR() 
  const APRObject = useMemo(() => {
    if (!APRs) return {
      weekly: "N/A",
      monthly: "N/A",
      three_month: "N/A",
      yearly: "N/A",
    }
    return {
      weekly: APRs.week_apr ? num(APRs?.week_apr).minus(num(APRs?.cost)).multipliedBy(100).toFixed(1) : "N/A",
      monthly: APRs.month_apr ? num(APRs?.month_apr).minus(num(APRs?.cost)).multipliedBy(100).toFixed(1) : "N/A",
      three_month: APRs.three_month_apr ? num(APRs?.three_month_apr).minus(num(APRs?.cost)).multipliedBy(100).toFixed(1) : "N/A",
      yearly: APRs.year_apr ? num(APRs?.year_apr).minus(num(APRs?.cost)).multipliedBy(100).toFixed(1) : "N/A",
    }
  }, [APRs])
  const longestAPR = useMemo(() => {
    if (!APRs) return "0"
    if (APRs.year_apr) return APRs.year_apr
    if (APRs.three_month_apr) return APRs.three_month_apr
    if (APRs.month_apr) return APRs.month_apr
    return APRs.week_apr??"0"
  }, [APRs])

  
  //Calc TVL in the Earn (Mars USDC looped) vault 
  const TVL = useMemo(() => {
    if (underlyingUSDC == "0" || !usdcPrice || !usdcAsset) return 0
    return shiftDigits(underlyingUSDC, usdcAsset?.decimal).toNumber() * usdcPrice
  }, [underlyingUSDC, usdcPrice])

  return (
    <HStack spacing="5" alignItems="flex-start">
      <Card p="8" gap={5} width={"100%"}>
        <Text variant="title" fontSize={"lg"} letterSpacing={"1px"}>Total Deposit</Text>
        <Text variant="body">{(TVL).toFixed(2)} USD</Text>  
        <HStack justifyContent="end" width={"100%"} gap={"1rem"}>
          <DepositButton />
          <WithdrawButton />
        </HStack>
      </Card>
      <Card p="8" gap={5} width={"100%"} height={"50%"} margin={"auto"} alignContent={"center"} flexWrap={"wrap"}>
      <Stack>          
          <HStack spacing="5" alignItems="flex-start">
            <Stack>
              <Text variant="title" fontSize={"lg"} letterSpacing={"1px"}>Last Week's APR</Text>
              <Divider />
              <Text variant="body">{APRObject.weekly}% </Text>
            </Stack>
            <Stack>
              <Text variant="title" fontSize={"lg"} letterSpacing={"1px"}>Last Month's APR</Text>
              <Divider />
              <Text variant="body">{APRObject.monthly}% </Text>
            </Stack>
            <Stack>
              <Text variant="title" fontSize={"lg"} letterSpacing={"1px"}>Last 3 Months' APR</Text>
              <Divider />
              <Text variant="body">{APRObject.three_month}% </Text>
            </Stack>
            <Stack>
              <Text variant="title" fontSize={"lg"} letterSpacing={"1px"}>Last Year's APR</Text>
              <Divider />
              <Text variant="body">{APRObject.yearly}% </Text>
            </Stack>
          </HStack>          
          <Divider />
          <Stack>
            <Text variant="title" fontSize={"lg"} letterSpacing={"1px"}>Estimated Annual Interest</Text>
            <Text variant="body">{(num(longestAPR).multipliedBy(TVL)).toFixed(2)} USD</Text>  
          </Stack>
        </Stack>
      </Card>
      {/* Add risk description */}
    </HStack>
  )
}

export default Deposit
