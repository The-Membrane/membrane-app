import { num } from '@/helpers/num'
import useWallet from '@/hooks/useWallet'
import {
  HStack,
  Slider,
  SliderFilledTrack,
  SliderThumb,
  SliderTrack,
  Stack,
  Text,
} from '@chakra-ui/react'
import useDelegateState from './hooks/useDelegateState'
import useDelegations from './hooks/useDelegations'

type Props = {}

const UpdateCommision = (props: Props) => {
  const { address } = useWallet()
  const { delegateState, setDelegateState } = useDelegateState()
  const { data: delegations = [] } = useDelegations()
  const existingDelegation = delegateState?.delegations?.find(
    (delegation) => delegation.address === address,
  )
  const delegateInfo = delegations?.find((d) => d.address === address)
  const value = num(existingDelegation?.newCommission || delegateInfo?.commission)
    .times(100)
    .toNumber()
  const max = num(delegateInfo?.maxCommission).times(100).toNumber()

  const onChange = (value: number) => {
    const newCommission = num(value).div(100).toNumber()
    const newDelegations = [
      {
        ...delegateInfo,
        newCommission,
      },
    ]
    setDelegateState({ delegations: newDelegations })
  }

  if (!delegateInfo) return null

  return (
    <Stack w="full">
      <HStack w="full" justifyContent="space-between">
        <Text variant="value" textTransform="none">
          Your commision as delegation
        </Text>
        <Text variant="value">{value}</Text>
      </HStack>

      <Slider
        aria-label="slider-ex-4"
        // defaultValue={defaultValue}
        value={value}
        max={max}
        onChange={onChange}
      >
        <SliderTrack bg="#E2D8DA" h="2" borderRadius="80px">
          <SliderFilledTrack bg="#C445F0" />
        </SliderTrack>
        <SliderThumb boxSize={6} bg="#C445F0" cursor="grab" border="2px solid #E2D8DA" />
      </Slider>
    </Stack>
  )
}

export default UpdateCommision
