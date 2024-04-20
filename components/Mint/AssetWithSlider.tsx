import { HStack, Stack, Text } from '@chakra-ui/react'
import { SliderWithState } from './SliderWithState'
import { AssetWithBalance } from './hooks/useCombinBalance'
import useMintState from './hooks/useMintState'
import { getSummary } from '@/helpers/mint'
import { num } from '@/helpers/num'
import useVaultSummary from './hooks/useVaultSummary'

export type AssetWithSliderProps = {
  label: string
  asset: AssetWithBalance
}

export const AssetWithSlider = ({ asset, label }: AssetWithSliderProps) => {
  const { mintState, setMintState } = useMintState()
  const { maxMint = 0, borrowLTV, debtAmount, ltv } = useVaultSummary()

  const onChange = (value: number) => {
    let updatedAssets = mintState.assets.map((asset) => {
      const sliderValue = asset.symbol === label ? value : asset.sliderValue || 0
      
      // We want to stop the slider from moving if they are looking withdraw assets that pushes them below the borrowLTV
      if (borrowLTV <= ltv && sliderValue <= (asset?.sliderValue??0)) return {...asset}

      const diffInUsd = num(asset.depositUsdValue).minus(sliderValue).toNumber()
      const newDepoist = num(asset.depositUsdValue).minus(diffInUsd).toNumber()
      const amountValue = num(diffInUsd).isGreaterThan(asset.depositUsdValue)
        ? newDepoist
        : -diffInUsd
      const amount = num(amountValue).dividedBy(asset.price).dp(6).toNumber()
      return {
        ...asset,
        amount,
        amountValue,
        sliderValue,
      }
    })

    const { summary, totalUsdValue } = getSummary(updatedAssets)

    setMintState({ assets: updatedAssets, summary, totalUsdValue })
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
