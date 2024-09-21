import React, { ChangeEvent, use, useEffect, useMemo } from 'react'
import { Card, HStack, Input, Stack, Text } from '@chakra-ui/react'
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
import useEarnLoop from './hooks/useEarnLoop'
import useCDPRedeem from './hooks/useCDPRedeem'
import useUSDCVaultCrankAPR from './hooks/useUSDCVaultCrankAPR'
import useWallet from '@/hooks/useWallet'

const EXIT_FEE = 0.005

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
  const { earnState, setEarnState } = useEarnState()
  const { data: prices } = useOraclePrice()
  const { data: basket } = useBasket()
  const { action: loop } = useEarnLoop()
  const { action: redeem } = useCDPRedeem()
  const { action: crankAPR } = useUSDCVaultCrankAPR()
  const cdtAsset = useAssetBySymbol('CDT')
  const CDTBalance = useBalanceByAsset(cdtAsset)
  const usdcAsset = useAssetBySymbol('USD')
  const usdcPrice = parseFloat(prices?.find((price) => price.denom === usdcAsset?.base)?.price ?? "0")
  
  const loopedUSDCAsset = useAssetBySymbol('loopedUSDCmars')
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

  
  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    e.preventDefault()
    setEarnState({ loopMax: parseInt(e.target.value) })
  }
  const handleRedeemInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    e.preventDefault()
    setEarnState({ redeemAmount: parseInt(e.target.value) })
  }


  return (
    <Stack>
      <HStack spacing="5" alignItems="flex-start" paddingLeft={"2vw"} paddingRight={"2vw"}>        
      <Stack>
          <Card p="8" gap={5} width={"100%"}>
            <Text variant="title" fontSize={"lg"} letterSpacing={"1px"}>Total Deposit</Text>
            <Text variant="body">{(TVL).toFixed(2)} USD</Text>  
            <HStack justifyContent="end" width={"100%"} gap={"1rem"}>
              <DepositButton />
              <WithdrawButton />
            </HStack>
          </Card>
          
          <Card>
              <Text variant="title" fontSize={"md"} letterSpacing={"1px"}>Who is the Yield?</Text>
              <Text variant="body" fontWeight={"bold"}> TLDR: 1. Looped Mars USDC yield, 2. CDT Redemptions, 3. Exit fee. {'\n'}{'\n'}</Text>
              <Text variant="body">
                This vault supplies USDC on Mars Protocol and loops it by collateralizing the Mars position to mint CDT,
                swap it for USDC & deposit it back to the Mars market. To enable lower rates for this strategy, the collateral position is open for profitable debt redemptions that act as downside liquidity for CDT.
                On top of that, there is a 0.5% exit fee that goes to remaining depositors in order to account for the slippage it takes to unloop & withdraw USDC.
                The exit fee from withdrawals that use the buffer of supplied USDC are pure profit for depositors, whereas withdrawals that need to be swapped will only be profitable if the slippage is lower than the max.
              </Text>          
              <Text variant="title" fontSize={"md"} letterSpacing={"1px"}>{'\n'}{'\n'}Recommended Deposit Time: ~{num(EXIT_FEE).dividedBy(num(APRs?.month_apr??"0").dividedBy(365)).toFixed(1)} days to overcome exit fee</Text>
            </Card>
            <Card>
              <Text variant="title" fontSize={"md"} letterSpacing={"1px"}>Global Vault Info</Text>
          </Card>
        </Stack>
        <Stack>    
          <Card p="7" gap={5} width={"100%"} height={"50%"} margin={"auto"} alignContent={"center"} flexWrap={"wrap"}>
            <Stack>          
                <Text variant="title" fontSize={"lg"} letterSpacing={"1px"}>Retroactive APRs</Text>
                <HStack spacing="5" alignItems="flex-start">
                  <Stack>
                    <Text variant="body" fontWeight={"bold"} letterSpacing={"1px"}>Week</Text>
                    <Divider marginTop={1} marginBottom={1}/>
                    <Text variant="body" justifyContent={"center"} display={"flex"}>{APRObject.weekly}% </Text>
                  </Stack>
                  <Stack>
                    <Text variant="body" fontWeight={"bold"} letterSpacing={"1px"}>Month</Text>
                    <Divider marginTop={1} marginBottom={1}/>
                    <Text variant="body" justifyContent={"center"} display={"flex"}>{APRObject.monthly}% </Text>
                  </Stack>
                  <Stack>
                    <Text variant="body" fontWeight={"bold"} letterSpacing={"1px"}>3M</Text>
                    <Divider marginTop={1} marginBottom={1}/>
                    <Text variant="body" justifyContent={"center"} display={"flex"}>{APRObject.three_month}% </Text>
                  </Stack>
                  <Stack>
                    <Text variant="body" fontWeight={"bold"} letterSpacing={"1px"}>Year</Text>
                    <Divider marginTop={1} marginBottom={1}/>
                    <Text variant="body" justifyContent={"center"} display={"flex"}>{APRObject.yearly}% </Text>
                  </Stack>
                </HStack>          
                <Divider />
                <Stack>
                  <Text variant="title" fontSize={"lg"} letterSpacing={"1px"}>Estimated Annual Interest</Text>
                  <Text variant="body">{(num(longestAPR).multipliedBy(TVL)).toFixed(2)} USD</Text>  
                </Stack>
            </Stack>
          </Card>          
          <Card>
            <Text variant="title" fontSize={"lg"} letterSpacing={"1px"}>Global Management</Text>
            <Stack>
              <HStack>
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
                    {/* Loop Button */}
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
                {/* "Did you buy CDT under 99% of peg (calc this)? Redeem USDC" */}
                {/* Redeen CDT input */}
                {/* Redeem Button */}
                <Stack py="5" w="full" gap="3" mb={"0"} >
                <Text variant="body"> Did you buy CDT {`<= $`}{num(basket?.credit_price.price??"0").multipliedBy(0.99).toFixed(2)}?</Text>
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
                    {/* Redeem Button */}
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
              </HStack>    
                {/* Crank APR Button */}
                <TxButton
                  maxW="100%"
                  isLoading={crankAPR?.simulate.isLoading || crankAPR?.tx.isPending}
                  isDisabled={crankAPR?.simulate.isError || !crankAPR?.simulate.data}
                  onClick={() => crankAPR?.tx.mutate()}
                  toggleConnectLabel={false}
                  style={{ alignSelf: "center" }}
                >
                  Crank APR
                </TxButton>
            </Stack>
          </Card>
        </Stack>
      </HStack>
    </Stack>
  )
}

export default Deposit
