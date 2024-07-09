import { HStack, Stack, Text } from '@chakra-ui/react'
import { getSummary } from '@/helpers/mint'
import { num } from '@/helpers/num'
import useQuickActionState from './hooks/useQuickActionState'
import { AssetWithBalance } from '../Mint/hooks/useCombinBalance'
import { SliderWithState } from '../Mint/SliderWithState'

export type AssetWithSliderProps = {
  label: string
  asset: AssetWithBalance
  onChangeExt: (value: number) => void
}

export const QuickActionAssetWithSlider = ({ asset, label, onChangeExt }: AssetWithSliderProps) => {
  const { quickActionState, setQuickActionState } = useQuickActionState()

  const onChange = (value: number) => {
    onChangeExt(value)
    let updatedAssets = quickActionState.assets.map((asset) => {
      const sliderValue = asset.symbol === label ? value : asset.sliderValue || 0
      
      const newDeposit = num(sliderValue).toNumber()
      const amount = num(newDeposit).dividedBy(asset.price).dp(asset.decimal??6).toNumber()
      
      //Find the asset in quickActionState levAssets and update the sliderValue
      let found = quickActionState?.levAssets?.findIndex((levAsset) => asset.symbol === levAsset.symbol)
      // console.log(quickActionState.levAssets?.find((levAsset) => asset.symbol === levAsset.symbol), quickActionState.levAssets?.find((levAsset) => asset.symbol === levAsset.symbol) != undefined, asset.symbol, quickActionState.levAssets)
      if((found??0) > 0 && quickActionState.levAssets) quickActionState.levAssets[found??0] = {
        ...asset,
        amount,
        sliderValue,
      }
      // && quickActionState.levAssets?.find((levAsset) => asset.symbol === levAsset.symbol) != undefined

      return {
        ...asset,
        amount,
        sliderValue,
      }
    })

    const { summary, totalUsdValue } = getSummary(updatedAssets)

    setQuickActionState({ assets: updatedAssets, levAssets: quickActionState.levAssets, totalUsdValue })
  }


  
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

