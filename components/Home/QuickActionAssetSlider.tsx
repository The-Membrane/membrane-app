import { HStack, Stack, Text } from '@chakra-ui/react'
import { getSummary } from '@/helpers/mint'
import { num } from '@/helpers/num'
import useQuickActionState from './hooks/useQuickActionState'
import { AssetWithBalance } from '../Mint/hooks/useCombinBalance'
import { SliderWithState } from '../Mint/SliderWithState'
import { delayTime } from '@/config/defaults'
import { useEffect } from 'react'

export type AssetWithSliderProps = {
  label: string
  asset: AssetWithBalance
  onChangeExt: (value: number) => void
}

export const QuickActionAssetWithSlider = ({ asset, label, onChangeExt }: AssetWithSliderProps) => {
  const { quickActionState, setQuickActionState } = useQuickActionState()

  const onChange = (value: number) => {
    let updatedAssets = quickActionState.assets.map((asset) => {
      const sliderValue = asset.symbol === label ? value : asset.sliderValue || 0
      
      const newDeposit = num(sliderValue).toNumber()
      const amount = num(newDeposit).dividedBy(asset.price).dp(asset.decimal??6).toNumber()

      return {
        ...asset,
        amount,
        sliderValue,
      }
    })

    const { summary, totalUsdValue } = getSummary(updatedAssets)

    setQuickActionState({ assets: updatedAssets, summary, totalUsdValue })
  }

  //When the amount in the input box changes, update the slider value on a delay
  useEffect(() => {
    setTimeout(() => {
      if (asset?.inputAmount != (asset?.sliderValue??0)) onChange(asset?.inputAmount)
    }, delayTime);  
  }, [asset?.inputAmount])

  console.log("Slider Value", asset?.sliderValue)

  
  return (
    <Stack gap="0">
      <HStack justifyContent="space-between">
        <Text variant="lable" textTransform="unset">
          {label}
        </Text>
        <HStack>
          <Text variant="value">${asset?.sliderValue?.toFixed(2)}</Text>
        </HStack>
      </HStack>
      <SliderWithState
        value={asset?.sliderValue}
        onChange={onChange}
        min={0}
        max={asset?.combinUsdValue}
      />
    </Stack>
  )
}

