import { HStack, Stack, Text } from '@chakra-ui/react'
import { num } from '@/helpers/num'
import { AssetWithBalance } from '../Mint/hooks/useCombinBalance'
import { SliderWithState } from '../Mint/SliderWithState'
import useNeuroState from './hooks/useNeuroState'

export type AssetWithSliderProps = {
  label: string
  asset: AssetWithBalance
  onChangeExt: (value: number) => void
}

export const NeuroAssetSlider = ({ asset, label, onChangeExt }: AssetWithSliderProps) => {
  const { neuroState, setNeuroState } = useNeuroState()

  const onChange = (value: number) => {
    onChangeExt(value)
    // let updatedAssets = neuroState.assets.map((asset) => {
    //   const sliderValue = asset.symbol === label ? value : asset.sliderValue || 0
      
    //   const newDeposit = num(sliderValue).toNumber()
    //   const amount = num(newDeposit).dividedBy(asset.price).dp(asset.decimal??6).toNumber()
    //   console.log("Neurological W", asset.symbol, amount, asset.decimal, asset.price, sliderValue)

    //   return {
    //     ...asset,
    //     amount,
    //     sliderValue,
    //   }
    // })

    // setNeuroState({ assets: updatedAssets })
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

