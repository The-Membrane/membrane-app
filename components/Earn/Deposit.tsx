import React, { ChangeEvent, use, useEffect, useMemo, useState } from 'react'
import { Button, Card, HStack, Input, Stack, Text } from '@chakra-ui/react'
import { TxButton } from '@/components/TxButton'
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
import { useUSDCVaultTokenUnderlying, useEarnUSDCEstimatedAPR, useVaultInfo, useEarnUSDCRealizedAPR } from './hooks/useEarnQueries'
import useEarnExit from './hooks/useEarn'
import Divider from '../Divider'
import useEarnLoop from './hooks/useEarnLoop'
import useCDPRedeem from './hooks/useCDPRedeem'
import useUSDCVaultCrankAPR from './hooks/useUSDCVaultCrankAPR'
import useEarn from './hooks/useEarn'
import { GrPowerReset } from 'react-icons/gr'
import ConfirmModal from '../ConfirmModal'
import { QASummary } from '../Home/QASummary'
import { colors } from '@/config/defaults'

// const ENTRY_FEE = 0.005

const DepositButton = () => {
  const { earnState, setEarnState } = useEarnState()
  const usdcAsset = useAssetBySymbol('USDC')
  const usdcBalance = useBalanceByAsset(usdcAsset)

  const { action: earn } = useEarn();

  const onSliderChange = (value: number) => {
    setEarnState({ deposit: value, withdraw: 0 })
  }

  return (
    <ActModal
      // px="5"
      // w="fit-content"
      // fontSize="sm"
      label="Deposit"
      isDisabled={!isGreaterThanZero(usdcBalance)}
      action={earn}
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
        <SliderWithState value={earnState.deposit} onChange={onSliderChange} min={0} max={parseFloat(usdcBalance)} walletCDT={1} summary={["empty"]} />
      </Stack>
    </ActModal>
  )
}

const WithdrawButton = () => {
  const { earnState, setEarnState } = useEarnState()
  const earnUSDCAsset = useAssetBySymbol('earnUSDC')
  const earnUSDCBalance = useBalanceByAsset(earnUSDCAsset)

  const { action: earn } = useEarn();

  //Set withdraw slider max to the total USDC deposit, not the looped VT deposit
  const { data } = useUSDCVaultTokenUnderlying(shiftDigits(earnUSDCBalance, 6).toFixed(0))
  const underlyingUSDC = data ?? "1"
  // const underlyingUSDC = "2000000"

  ////////////////////////////////////

  const onSliderChange = (value: number) => {
    console.log("withdraw", value)
    setEarnState({ withdraw: value, deposit: 0 })
  }

  return (
    <ActModal
      // px="5"
      // w="fit-content"
      // fontSize="sm"
      label="Withdraw"
      isDisabled={!isGreaterThanZero(underlyingUSDC)}
      action={earn}
    >
      <Stack gap="0">
        <HStack justifyContent="space-between">
          <Text variant="lable" textTransform="unset">
            USDC
          </Text>
          <HStack>
            <Text variant="value">${earnState.withdraw}</Text>
          </HStack>
        </HStack>
        <SliderWithState value={earnState.withdraw} onChange={onSliderChange} min={0} max={shiftDigits(underlyingUSDC ?? 1, -6).toNumber()} walletCDT={1} summary={["empty"]} />
      </Stack>
    </ActModal>
  )
}


const ActSlider = React.memo(() => {
  const { earnState, setEarnState } = useEarnState()
  const { data: vaultInfo } = useVaultInfo()
  const earnUSDCAsset = useAssetBySymbol('earnUSDC')
  const earnUSDCBalance = useBalanceByAsset(earnUSDCAsset)
  const usdcAsset = useAssetBySymbol('USDC')
  const usdcBalance = useBalanceByAsset(usdcAsset)
  const { data: prices } = useOraclePrice()
  const { data: basket } = useBasket()
  const cdtPrice = parseFloat(prices?.find((price) => price.denom === "factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt")?.price ?? "0")

  const { action: earn } = useEarn()

  //Find exit fee ratio (i.e. fee of 1% = 0.99)
  const exitFeeRatio = useMemo(() => {
    return 1
    // if (!basket) return 0
    // const pegRatio = num(cdtPrice).dividedBy(basket?.credit_price.price)
    // const exitFee = pegRatio > num(0.99) ? pegRatio.minus(0.99) : 0
    // return num(1).minus(exitFee)
  }, [cdtPrice, basket])

  //Set withdraw slider max to the total USDC deposit, not the looped VT deposit
  const { data } = useUSDCVaultTokenUnderlying(shiftDigits(earnUSDCBalance, 6).toFixed(0))
  const underlyingUSDC = useMemo(() => {
    const baseUnderlying = shiftDigits(data, -6).toString() ?? "1"
    return num(baseUnderlying).times(exitFeeRatio).toString()
  }, [exitFeeRatio, data])
  ////////////////////////////////////

  const logo = useMemo(() => { return usdcAsset?.logo }, [usdcAsset])

  const totalBalance = useMemo(() => {
    return num(underlyingUSDC).plus(usdcBalance).toString()
  }, [usdcBalance, underlyingUSDC])

  const pendingBalance = useMemo(() => {
    return num(underlyingUSDC).plus(earnState.deposit).minus(earnState.withdraw).toNumber()
  }, [underlyingUSDC, earnState.deposit, earnState.withdraw])
  //set amount label 
  const actingAmount = useMemo(() => {
    return (earnState.deposit > 0 ? earnState.deposit : earnState.withdraw).toFixed(2)
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
    <Stack gap="0">
      <HStack justifyContent="space-between" padding="2%">
        <Text variant="lable" textTransform="unset">
          USDC in Vault
        </Text>
        <HStack>
          <Text variant="value">${pendingBalance.toFixed(2)}</Text>
        </HStack>
      </HStack>
      <SliderWithState
        width="97%"
        padding="1%"
        value={num(underlyingUSDC).minus(earnState.withdraw).plus(earnState.deposit).toNumber()}
        onChange={onSliderChange}
        max={Number(totalBalance)}
      />

      <HStack gap={0} padding="2%">
        <Button variant="ghost" width={"10"} padding={0} leftIcon={<GrPowerReset />} onClick={onReset} />
        <ConfirmModal
          label={(earnState.deposit > 0 && (vaultInfo?.debtAmount ?? 0) >= 200) ? "Deposits Disabled: Debt >= 200 CDT" : earnState.deposit > 0 ? `Deposit ${actingAmount.toString()} USDC` : earnState.withdraw > 0 ? `Withdraw ${actingAmount.toString()} USDC` : "Manage"}
          action={earn}
          isDisabled={Number(totalBalance) < 1 || pendingBalance === num(underlyingUSDC).toNumber() || (earnState.deposit > 0 && (vaultInfo?.debtAmount ?? 0) >= 200)}>
          <QASummary logo={logo} />
        </ConfirmModal>
      </HStack>
    </Stack>
  )
});

const Deposit = () => {
  const { earnState, setEarnState } = useEarnState()
  const { data: prices } = useOraclePrice()
  const { data: basket } = useBasket()
  const { action: loop } = useEarnLoop()
  const { action: redeem } = useCDPRedeem()
  console.log("redeem", redeem.simulate.data, redeem.simulate.isError, redeem.simulate.error)
  const { action: crankAPR } = useUSDCVaultCrankAPR()
  const cdtAsset = useAssetBySymbol('CDT')
  const CDTBalance = useBalanceByAsset(cdtAsset)
  const usdcAsset = useAssetBySymbol('USDC')
  const usdcPrice = parseFloat(prices?.find((price) => price.denom === usdcAsset?.base)?.price ?? "0")

  const earnUSDCAsset = useAssetBySymbol('earnUSDC')
  const earnUSDCBalance = useBalanceByAsset(earnUSDCAsset)
  const { data: underlyingUSDC } = useUSDCVaultTokenUnderlying(shiftDigits(earnUSDCBalance, 6).toFixed(0))
  console.log("underlyingUSDC", usdcPrice, underlyingUSDC)

  //Get the time since Sep 22, 2024, 7:50:35 PM (UTC) in seconds
  //Days since Earn vault launch
  // const daysSinceLaunch = num(Math.floor(Date.now() / 1000) - 1727005835).dividedBy(86400)
  // console.log("daysSinceLaunch", daysSinceLaunch)

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
    console.log("APR logs", APRs)
    return {
      weekly: APRs.week_apr ? num(APRs?.week_apr).minus(num(vaultInfo?.cost)).times(vaultInfo?.leverage ?? 1).multipliedBy(100).toFixed(1) : "N/A",
      monthly: APRs.month_apr ? num(APRs?.month_apr).minus(num(vaultInfo?.cost)).times(vaultInfo?.leverage ?? 1).multipliedBy(100).toFixed(1) : "N/A",
      three_month: APRs.three_month_apr ? num(APRs?.three_month_apr).minus(num(vaultInfo?.cost)).times(vaultInfo?.leverage ?? 1).multipliedBy(100).toFixed(1) : "N/A",
      yearly: APRs.year_apr ? num(APRs?.year_apr).minus(num(vaultInfo?.cost)).times(vaultInfo?.leverage ?? 1).multipliedBy(100).toFixed(1) : "N/A",
    }
  }, [APRs, vaultInfo])
  const { longestAPR } = useMemo(() => {
    if (!APRObject) return { longestAPR: "0" }
    if (APRObject.yearly && APRObject.yearly != "N/A") return { longestAPR: APRObject.yearly }
    if (APRObject.three_month && APRObject.three_month != "N/A") return { longestAPR: APRObject.three_month }
    if (APRObject.monthly && APRObject.monthly != "N/A") return { longestAPR: APRObject.monthly }
    return { longestAPR: APRObject.weekly }
  }, [APRObject])
  console.log("longest APR log", longestAPR)


  //Calc userTVL in the Earn (Mars USDC looped) vault 
  const userTVL = useMemo(() => {
    if (underlyingUSDC == "0" || !usdcPrice || !usdcAsset) return 0
    return (shiftDigits(underlyingUSDC, -(usdcAsset?.decimal)).toNumber() * usdcPrice).toFixed(2)
  }, [underlyingUSDC, usdcPrice])


  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    e.preventDefault()
    setEarnState({ loopMax: parseInt(e.target.value) })
  }
  const handleRedeemInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    e.preventDefault()
    setEarnState({ redeemAmount: parseInt(e.target.value) })
  }

  console.log("loop", loop?.simulate.data, loop?.simulate.isError, loop?.simulate.error)
  return (
    <Stack>
      <HStack spacing="5" alignItems="flex-start" paddingLeft={"2vw"} paddingRight={"2vw"}>
        <Stack>
          <Card>
            <Text variant="title" fontSize={"md"} letterSpacing={"1px"}>Global Vault Info</Text>
            <HStack justifyContent="end" width={"100%"} gap={"1rem"}>
              {vaultInfo ?
                <><HStack><Text variant="title" fontSize={"md"} letterSpacing={"1px"} >TVL: </Text><Text variant="body">${vaultInfo.totalTVL.toFixed(0)}</Text></HStack>
                  <HStack><Text variant="title" fontSize={"md"} letterSpacing={"1px"} >Debt: </Text><Text variant="body">{vaultInfo.debtAmount} CDT</Text></HStack>
                  <HStack><Text variant="title" fontSize={"md"} letterSpacing={"1px"} >Base TVL: </Text><Text variant="body">${vaultInfo.unleveragedValue.toFixed(0)}</Text></HStack>
                  <HStack><Text variant="title" fontSize={"md"} letterSpacing={"1px"} >Leverage: </Text><Text variant="body">{vaultInfo.leverage.toFixed(2)}x</Text></HStack></>
                :
                <Text variant="body" width={"100%"} display="flex" justifyContent="center">loading...</Text>}
            </HStack>
          </Card>
          <Card p="8" gap={5} width={"100%"} borderWidth={"7px"} borderColor={colors.sliderCardBorder} borderRadius={"2rem"}>
            <ActSlider />
          </Card>

          {(vaultInfo?.debtAmount ?? 0) >= 200 ? <Text variant="title" justifyContent="center" display={"flex"} fontSize={"md"} letterSpacing={"1px"} mb={1} color={colors.alert} >Alert: Deposits DISABLED while above 200 debt</Text> : null}

          <Card>

            <Text variant="body" fontWeight={"bold"} mb={1}> TLDR: Looped Mars USDC yield, CDT Redemptions, 0.5% entry fee but you pay unloop cost{'\n'}</Text>

            <Divider />

            <Text variant="title" fontSize={"md"} letterSpacing={"1px"} mb={1} textDecoration={"underline"}>Who is the Yield?</Text>
            <Text variant="body" mb={1}>
              This vault <a style={{ fontWeight: "bold", color: colors.textHighlight }}>supplies USDC on Mars Protocol</a> and loops it by collateralizing the Mars position to mint CDT,
              swap it for USDC & deposit it back to the Mars USDC market. The Mars USDC market only distributes yield as borrowers repay so even if the APR is 100%, this Manic vault earns nothing until Mars borrowers repay.
              Due to this, we can't offer a recommended deposit time to recoup the entry fee.
            </Text>
            <Text variant="body" mb={1}> The vault's collateral position is open for <a style={{ fontWeight: "bold", color: colors.textHighlight }}>profitable debt redemptions</a> that act as downside liquidity for CDT which adds additional yield to depositors while keeping CDT's peg tight.</Text>
            <Text variant="body" mb={1}>On top of that, there is a <a style={{ fontWeight: "bold", color: colors.textHighlight }}>0.5% entry fee</a> that is pure profit. The "catch" is that this is a yield cushion because depositors <a style={{ fontWeight: "bold", color: colors.textHighlight }}>are responsible for their unlooping costs</a>.
              So if you decide to unloop at a bad conversion rate, above 99%, you will lose some capital on the trade out, on top of slippage (max: 0.5%).
            </Text>
            <Text variant="title" fontSize={"md"} letterSpacing={"1px"} mb={1} textDecoration={"underline"}>{'\n'} Why does my TVL fluctuate?</Text>
            <Text variant="body" mb={1}>Your TVL represents a portion of the vault's TVL. The vault's TVL may temporary decrease as <a style={{ fontWeight: "bold", color: colors.textHighlight }}>it takes $1 of CDT in protocol debt and sells it on the market</a>,
              the lowest conversion rate being $0.99. This difference will be recouped as the vault's CDP position gets redeemed against & from the entry fee of any deposits.
              Redemptions can be profitable if our loop conversion rate is above 99% & at least even at the 99% floor. This makes any TVL fluctuations temporary & part of the vault's normal functionality.
            </Text>
          </Card>
        </Stack>
        <Stack>
          <Card p="7" gap={5} width={"100%"} height={"50%"} margin={"auto"} alignContent={"center"} flexWrap={"wrap"}>
            <Stack>
              <HStack spacing="5" alignItems="flex-start">
                <Stack>
                  <Text variant="title" fontSize={"lg"} letterSpacing={"1px"} justifyContent={"center"} display="flex">{realizedAPR ? `${realizedAPR?.runningDuration.toString()}D` : "N/A"} </Text>
                  <Text variant="title" fontSize={"lg"} letterSpacing={"1px"} justifyContent={"center"} display="flex">APR </Text>
                  <Divider marginTop={1} marginBottom={1} />
                  <Text variant="body" justifyContent={"center"} display="flex" fontWeight={"bold"} letterSpacing={"1px"}>{realizedAPR?.negative ? "-" : ""}{(realizedAPR && realizedAPR.apr) ? num(realizedAPR?.apr).times(100).toFixed(1) : "N/A"}%</Text>
                </Stack>
                <Stack>
                  <Text variant="title" fontSize={"lg"} letterSpacing={"1px"} justifyContent={"center"} display="flex">Estimated</Text>
                  <Text variant="title" fontSize={"lg"} letterSpacing={"1px"} justifyContent={"center"} display="flex">APR </Text>
                  <Divider marginTop={1} marginBottom={1} />
                  <Text variant="body" justifyContent={"center"} display="flex" fontWeight={"bold"} >{longestAPR}% </Text>
                </Stack>
              </HStack>

              <Divider />

              <Stack>
                <Text variant="title" fontSize={"lg"} letterSpacing={"1px"}>Estimated Annual Interest</Text>
                <Text variant="body" fontWeight={"bold"}>{(num(longestAPR).dividedBy(100).multipliedBy(userTVL)).toFixed(2)} USD</Text>
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
                  <Text variant="body"> Did you buy CDT {`<= $`}{num(basket?.credit_price.price ?? "0").multipliedBy(0.985).toFixed(3)}?</Text>
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
