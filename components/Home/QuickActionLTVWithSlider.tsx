import { num } from '@/helpers/num'
import { HStack, Stack, Text } from '@chakra-ui/react'
import { useMemo } from 'react'
import useQuickActionState from './hooks/useQuickActionState'
import useQuickActionVaultSummary from './hooks/useQuickActionVaultSummary'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { SliderWithState } from '../Mint/SliderWithState'

export type LTVWithSliderProps = {
  label: string
  value?: number
}

export const QuickActionLTVWithSlider = ({ label, value = 100 }: LTVWithSliderProps) => {
  const { quickActionState, setQuickActionState } = useQuickActionState()
  const { maxMint = 0, debtAmount } = useQuickActionVaultSummary()
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
  useMemo(() => {
    mint = 0
    setQuickActionState({ mint})
    return num(debtAmount).times(100).dividedBy(maxMint).dp(2).toNumber()
  }, [debtAmount])

  const onChange = (value: number) => {
    var newValue = num(value).dp(2).toNumber()
    
    //Minimum debt show error msg
    if (newValue < 100) newValue = 100

    const diff = num(debtAmount).minus(newValue).abs().toNumber()
    mint = num(newValue).isGreaterThan(debtAmount) ? diff : 0
    repay = num(newValue).isLessThan(debtAmount) ? diff : 0

    setQuickActionState({ mint })
  }

  return (
    <Stack gap="0" px="0">
      <HStack justifyContent="space-between">
        <Text variant="lable" textTransform="unset">
          {label} { (quickActionState?.mint??0) > 0.1 ? "(+$"+(quickActionState?.mint??0).toFixed(2)+")" : "(mintable: $"+maxMintLabel+")"}
        </Text>
        <HStack>
          <Text variant="value">${value}</Text>
        </HStack>
      </HStack>
      <SliderWithState value={quickActionState.swapInsteadof ? 0 : value} onChange={onChange} min={0} max={maxSlider} walletCDT={parseFloat(walletCDT)} summary={[quickActionState?.selectedAsset]}/>
    </Stack>
  )
}
