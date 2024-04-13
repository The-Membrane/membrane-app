import { num, shiftDigits } from '@/helpers/num'
import usePagination from '@/hooks/usePagination'
import { ChevronLeftIcon, ChevronRightIcon } from '@chakra-ui/icons'
import {
  Button,
  Divider,
  HStack,
  Slider,
  SliderFilledTrack,
  SliderThumb,
  SliderTrack,
  Stack,
  Text,
} from '@chakra-ui/react'
import { GrPowerReset } from 'react-icons/gr'
import ConfirmModal from '../ConfirmModal'
import useStaked from '../Stake/hooks/useStaked'
import TxError from '../TxError'
import { Summary } from './Summary'
import Validator from './Validator'
import useDelegateState from './hooks/useDelegateState'
import useDelegations from './hooks/useDelegations'
import useUpdateDelegation from './hooks/useUpdateDelegation'
import UpdateCommision from './UpdateCommision'

type DelegateProps = {
  validator: any
  isDisabled?: boolean
}

const DelegateSlider = ({ validator, isDisabled }: DelegateProps) => {
  const { name, amount, socials, address } = validator
  const { delegateState, setDelegateState } = useDelegateState()
  const { delegations = [] } = delegateState || {}
  const existingDelegation = delegations?.find((delegation) => delegation.address === address)
  const { data: staked } = useStaked()

  const { data: userDelegation = [] } = useDelegations()

  const stakedAmount = shiftDigits(staked?.staked || 0, -6)
  const totalDelegation = userDelegation.reduce(
    (acc, validator) => num(acc).plus(validator.amount).toNumber(),
    0,
  )

  const remaining = num(stakedAmount).minus(totalDelegation).toNumber()
  const max = num(amount).plus(remaining).toNumber()

  const onChange = (value: number) => {
    const newAmount = num(value).minus(amount).toNumber()
    const newDelegations = delegations?.map((delegation) => {
      if (delegation.address === address) {
        return {
          ...validator,
          ...delegation,
          amount,
          newAmount,
        }
      }
      return delegation
    })

    if (!existingDelegation) {
      newDelegations.push({ name, amount, newAmount, address, socials })
    }
    setDelegateState({ delegations: newDelegations })
  }

  const delegationAmount = num(amount)
    .plus(existingDelegation?.newAmount || 0)
    .toNumber()

  return (
    <Stack w="full">
      <HStack w="full" justifyContent="space-between">
        <Validator name={name} address={address} socials={socials} />
        <Text variant="value">{delegationAmount}</Text>
      </HStack>

      <Slider
        aria-label="slider-ex-4"
        defaultValue={0}
        value={delegationAmount}
        min={0}
        max={max}
        onChange={onChange}
        isDisabled={isDisabled}
      >
        <SliderTrack bg="#E2D8DA" h="2" borderRadius="80px">
          <SliderFilledTrack bg="#C445F0" />
        </SliderTrack>
        <SliderThumb boxSize={6} bg="#C445F0" cursor="grab" border="2px solid #E2D8DA" />
      </Slider>
    </Stack>
  )
}

type PaginationProps = {
  currentPage: number
  totalPages: number
  previousPage: () => void
  nextPage: () => void
}

const Pagination = ({ previousPage, currentPage, totalPages, nextPage }: PaginationProps) => {
  return (
    <HStack w="full" justifyContent="center" gap="3" bg="blackAlpha.600" p="2" borderRadius="md">
      <Button
        variant="ghost"
        size="sm"
        leftIcon={<ChevronLeftIcon />}
        w="fit-content"
        colorScheme="gray"
        onClick={previousPage}
      >
        Previous
      </Button>
      <Text fontSize="sm" px="3" py="1" borderRadius="md" bg="whiteAlpha.300">
        {currentPage}
      </Text>
      <Text fontSize="sm">of {totalPages}</Text>
      <Button
        variant="ghost"
        size="sm"
        rightIcon={<ChevronRightIcon />}
        w="fit-content"
        colorScheme="gray"
        onClick={nextPage}
      >
        Next
      </Button>
    </HStack>
  )
}

const DelegateList = () => {
  const { data: userDelegations = [] } = useDelegations()
  const updateDelegation = useUpdateDelegation()
  const { delegateState, setDelegateState } = useDelegateState()

  const { delegations = [] } = delegateState || {}
  const activeSlider = delegations?.[0]

  const { paginatedData, nextPage, previousPage, currentPage, totalPages } = usePagination<any>(
    userDelegations,
    4,
  )

  const onRest = () => {
    setDelegateState({ delegations: [] })
  }

  const isDisabled = !delegateState?.delegations?.length

  return (
    <Stack w="full">
      <Stack minH="230px">
        {paginatedData.map((validator) => (
          <DelegateSlider
            key={validator?.name}
            validator={validator}
            isDisabled={activeSlider ? activeSlider?.address !== validator?.address : false}
          />
        ))}
      </Stack>

      <Pagination
        currentPage={currentPage}
        totalPages={totalPages}
        nextPage={nextPage}
        previousPage={previousPage}
      />

      <Divider
        bg="rgba(226, 216, 218, 0.24)"
        boxShadow="0px 0px 8px 0px rgba(226, 216, 218, 0.64)"
        h="1px"
        my="5"
      />

      <UpdateCommision />

      <HStack mt="5">
        <Button variant="ghost" leftIcon={<GrPowerReset />} onClick={onRest}>
          Reset
        </Button>
        <ConfirmModal label={'Update delegation'} action={updateDelegation} isDisabled={isDisabled}>
          <Summary />
        </ConfirmModal>
      </HStack>
    </Stack>
  )
}

export default DelegateList
