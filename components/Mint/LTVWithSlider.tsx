import { num } from '@/helpers/num'
import { HStack, Stack, Text } from '@chakra-ui/react'
import { SliderWithState } from './SliderWithState'
import useMintState from './hooks/useMintState'
import useVaultSummary from './hooks/useVaultSummary'

export type LTVWithSliderProps = {
  label: string
  value?: number
}

export const LTVWithSlider = ({ label, value = 0 }: LTVWithSliderProps) => {
  const { setMintState } = useMintState()
  const { tvl, borrowLTV, debtAmount } = useVaultSummary()
  const max = num(borrowLTV).times(tvl).dividedBy(100).dp(2).toNumber()

  const onChange = (value: number) => {
    const newValue = num(value).dp(2).toNumber()
    const diff = num(debtAmount).minus(newValue).abs().toNumber()
    const mint = num(newValue).isGreaterThan(debtAmount) ? diff : 0
    const repay = num(newValue).isLessThan(debtAmount) ? diff : 0
    const ltvSlider = num(newValue).times(100).dividedBy(max).dp(2).toNumber()

    setMintState({ mint, repay, ltvSlider })
  }

  return (
    <Stack gap="0" px="3">
      <HStack justifyContent="space-between">
        <Text variant="lable" textTransform="unset">
          {label}
        </Text>
        <HStack>
          <Text variant="value">${value}</Text>
        </HStack>
      </HStack>
      <SliderWithState value={value} onChange={onChange} min={0} max={max} />
    </Stack>
  )
}
