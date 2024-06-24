import { HStack, Stack, Text } from '@chakra-ui/react'
import { num } from '@/helpers/num'
import { AssetWithBalance } from '../Mint/hooks/useCombinBalance'
import { SliderWithState } from '../Mint/SliderWithState'
import { delayTime } from '@/config/defaults'
import { useEffect } from 'react'
import useNFTState from './hooks/useNFTState'

export type AssetWithSliderProps = {
  label: string
  asset: AssetWithBalance
  onChangeExt: (value: number) => void
}

export const NFTAssetSlider = ({ asset, label, onChangeExt }: AssetWithSliderProps) => {
  const { NFTState, setNFTState } = useNFTState()

  const onChange = (value: number) => {
    onChangeExt(value)
    let updatedAssets = NFTState.assets.map((asset) => {
      const sliderValue = asset.symbol === label ? value : asset.sliderValue || 0
      
      const newDeposit = num(sliderValue).toNumber()
      const amount = num(newDeposit).dividedBy(asset.price).dp(asset.decimal??6).toNumber()
      console.log(asset.symbol, amount, asset.decimal, asset.price, sliderValue)

      return {
        ...asset,
        amount,
        sliderValue,
      }
    })

    setNFTState({ assets: updatedAssets })
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
        onChange={onChangeExt}
        min={0}
        max={asset?.combinUsdValue}
      />
    </Stack>
  )
}

