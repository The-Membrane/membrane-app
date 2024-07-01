import { num } from '@/helpers/num'
import { HStack, Stack, Text } from '@chakra-ui/react'
import { useEffect, useMemo } from 'react'
import { SliderWithState } from './SliderWithState'
import useMintState from './hooks/useMintState'
import useVaultSummary from './hooks/useVaultSummary'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { useAssetBySymbol } from '@/hooks/useAssets'


const calcSliderValue = (debtAmount: number, mint: number = 0, repay: number = 0) => {
  console.log("calc slider value", debtAmount, mint, repay) //60
  return num(debtAmount).plus(mint).minus(repay).dp(2).toNumber()
}

export type LTVWithSliderProps = {
  label: string
  value?: number
}

export const LTVWithSlider = ({ label }: LTVWithSliderProps) => {
  const { setMintState, mintState } = useMintState()
  const { data } = useVaultSummary()
  const SumData = useMemo(() => { if (data) return data }, [data])  
  const { debtAmount, maxMint } = SumData || {
    debtAmount: 0,
    cost: 0,
    tvl: 0,
    ltv: 0,
    borrowLTV: 0,
    liquidValue: 0,
    liqudationLTV: 0,
    maxMint: 0,
  }
  console.log("LTV vault sum data:", data, SumData)

  const value = calcSliderValue(debtAmount, mintState.mint, mintState.repay)
  const CDT = useAssetBySymbol('CDT')
  const walletCDT = useBalanceByAsset(CDT)

  const maxMintLabel = useMemo(() => {
    if (num(maxMint).minus(debtAmount).dp(0).toNumber() < 0) return 0
    return num(maxMint).minus(debtAmount).dp(0).toNumber()
  }, [maxMint, debtAmount])

  const maxSlider = useMemo(() => {
    if (num(maxMint).minus(debtAmount).dp(0).toNumber() < 0) return debtAmount
    return num(maxMint).dp(0).toNumber()
  }, [maxMint, debtAmount])
  console.log("max slider", maxSlider, maxMint, debtAmount)

  //For refreshes on state updates (ex: successful tx)
  var mint = 0
  var repay = 0
  var ltvSlider = useMemo(() => {
    console.log("mint state reset") //55
    return num(debtAmount).times(100).dividedBy(maxMint??1).dp(2).toNumber()
  }, [debtAmount])

  const onChange = (value: number) => {
    var newValue = num(value).dp(2).toNumber()
    
    //Minimum debt show error msg
    if (newValue < 100 && newValue != 0 && !mintState?.belowMinDebt) {
      setMintState({ belowMinDebt: true })
    } else if ((newValue >= 100 || newValue === 0) && mintState?.belowMinDebt){ 
      setMintState({ belowMinDebt: false }) 
    }

    const diff = num(debtAmount).minus(newValue).abs().toNumber()
    mint = num(newValue).isGreaterThan(debtAmount) ? diff : 0
    repay = num(newValue).isLessThan(debtAmount) ? diff : 0
    ltvSlider = num(newValue).times(100).dividedBy(maxMint??1).dp(2).toNumber()

    //Repay stopper at wallet's CDT balance
    if (repay > parseFloat(walletCDT)) {
      repay = parseFloat(walletCDT)
      ltvSlider = num(debtAmount).minus(repay).times(100).dividedBy(maxMint??1).dp(2).toNumber()
    }

    //If repaying everything, use all the Wallet's CDT to get past the minimum debt barrier
    if (repay > 0 && newValue == 0) {
      repay = parseFloat(walletCDT)
      ltvSlider = 0
    }

    setMintState({ mint, repay, ltvSlider, newDebtAmount: newValue })
  }

  return (
    <Stack gap="0" px="3">
      <HStack justifyContent="space-between">
        <Text variant="lable" textTransform="unset">
          {label} { (mintState?.mint??0) > 0.1 ? "(+$"+(mintState?.mint??0).toFixed(2)+")" : (mintState?.repay??0) > debtAmount ? "(-$"+(debtAmount).toFixed(2)+")" : (mintState?.repay??0) > 0.1 ? "(-$"+(mintState?.repay??0).toFixed(2)+")" : "(mintable: $"+maxMintLabel+")"}
        </Text>
        <HStack>
          <Text variant="value">${Math.max(value, 0)}</Text>
        </HStack>
      </HStack>
      <SliderWithState value={value} onChange={onChange} min={0} max={maxSlider} walletCDT={parseFloat(walletCDT)} summary={mintState.summary}/>
    </Stack>
  )
}
