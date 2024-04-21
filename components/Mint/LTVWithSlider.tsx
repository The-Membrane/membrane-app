import { num } from '@/helpers/num'
import { HStack, Stack, Text } from '@chakra-ui/react'
import { useMemo } from 'react'
import { SliderWithState } from './SliderWithState'
import useMintState from './hooks/useMintState'
import useVaultSummary from './hooks/useVaultSummary'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { useAssetBySymbol } from '@/hooks/useAssets'

export type LTVWithSliderProps = {
  label: string
  value?: number
}

export const LTVWithSlider = ({ label, value = 0 }: LTVWithSliderProps) => {
  const { setMintState, mintState } = useMintState()
  const { maxMint = 0, debtAmount } = useVaultSummary()
  const CDT = useAssetBySymbol('CDT')
  const walletCDT = useBalanceByAsset(CDT)

  const maxMintLabel = useMemo(() => {
    if (isNaN(maxMint)) return 0
    if (num(maxMint).minus(debtAmount).dp(0).toNumber() < 0) return 0
    return num(maxMint).minus(debtAmount).dp(0).toNumber()
  }, [maxMint, debtAmount])

  const maxSlider = useMemo(() => {
    if (isNaN(maxMint)) return 0
    if (num(maxMint).minus(debtAmount).dp(0).toNumber() < 0) return debtAmount
    return num(maxMint).dp(0).toNumber()
  }, [maxMint, debtAmount]) 

  //For refreshes on state updates (ex: successful tx)
  var mint = 0
  var repay = 0
  var ltvSlider = useMemo(() => {
    mint = 0
    repay = 0
    setMintState({ mint, repay})
    return num(debtAmount).times(100).dividedBy(maxMint).dp(2).toNumber()
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
    ltvSlider = num(newValue).times(100).dividedBy(maxMint).dp(2).toNumber()

    //Repay stopper at wallet's CDT balance
    if (repay > parseFloat(walletCDT)) {
      repay = parseFloat(walletCDT)
      ltvSlider = num(debtAmount).minus(repay).times(100).dividedBy(maxMint).dp(2).toNumber()
    }

    setMintState({ mint, repay, ltvSlider, newDebtAmount: newValue })
  }

  return (
    <Stack gap="0" px="3">
      <HStack justifyContent="space-between">
        <Text variant="lable" textTransform="unset">
          {label} { (mintState?.mint??0) > 0.1 ? "(+$"+(mintState?.mint??0).toFixed(2)+")" : (mintState?.repay??0) > 0.1 ? "(-$"+(mintState?.repay??0).toFixed(2)+")" : "(mintable: $"+maxMintLabel+")"}
        </Text>
        <HStack>
          <Text variant="value">${value}</Text>
        </HStack>
      </HStack>
      <SliderWithState value={value} onChange={onChange} min={0} max={maxSlider} walletCDT={parseFloat(walletCDT)} summary={mintState.summary}/>
    </Stack>
  )
}
