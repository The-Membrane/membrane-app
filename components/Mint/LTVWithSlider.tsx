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
  const { maxLTV = 0, debtAmount } = useVaultSummary()
  const CDT = useAssetBySymbol('CDT')
  const walletCDT = useBalanceByAsset(CDT)

  const maxMint = useMemo(() => {
    if (isNaN(maxLTV)) return 0
    // if (num(maxLTV).minus(debtAmount).dp(0).toNumber() < 0) return 0
    return num(maxLTV).minus(debtAmount).dp(0).toNumber()
  }, [maxLTV, debtAmount])

  const maxSlider = useMemo(() => {
    if (isNaN(maxLTV)) return 0
    if (num(maxLTV).minus(debtAmount).dp(0).toNumber() < 0) return debtAmount
    return num(maxLTV).dp(0).toNumber()
  }, [maxLTV, debtAmount]) 

  //For refreshes on state updates (ex: successful tx)
  var mint = 0
  var repay = 0
  var ltvSlider = useMemo(() => {
    mint = 0
    repay = 0
    setMintState({ mint, repay})
    return num(debtAmount).times(100).dividedBy(maxLTV).dp(2).toNumber()
  }, [maxLTV, debtAmount])

  const onChange = (value: number) => {
    const newValue = num(value).dp(2).toNumber()
    const diff = num(debtAmount).minus(newValue).abs().toNumber()
    mint = num(newValue).isGreaterThan(debtAmount) ? diff : 0
    repay = num(newValue).isLessThan(debtAmount) ? diff : 0
    ltvSlider = num(newValue).times(100).dividedBy(maxLTV).dp(2).toNumber()

    if (repay > parseFloat(walletCDT)) {
      repay = parseFloat(walletCDT)
      ltvSlider = num(debtAmount).minus(repay).times(100).dividedBy(maxLTV).dp(2).toNumber()
    }

    setMintState({ mint, repay, ltvSlider, newDebtAmount: newValue })
  }

  return (
    <Stack gap="0" px="3">
      <HStack justifyContent="space-between">
        <Text variant="lable" textTransform="unset">
          {label} { (mintState?.mint??0) > 0.1 ? "(+$"+(mintState?.mint??0).toFixed(2)+")" : (mintState?.repay??0) > 0.1 ? "(-$"+(mintState?.repay??0).toFixed(2)+")" : "(mintable: $"+maxMint+")"}
        </Text>
        <HStack>
          <Text variant="value">${value}</Text>
        </HStack>
      </HStack>
      <SliderWithState value={value} onChange={onChange} min={0} max={maxSlider} walletCDT={parseFloat(walletCDT)}/>
    </Stack>
  )
}
