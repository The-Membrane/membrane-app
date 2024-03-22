import { ChevronLeftIcon, ChevronRightIcon } from '@chakra-ui/icons'
import {
  HStack,
  Slider,
  SliderTrack,
  SliderFilledTrack,
  SliderThumb,
  Stack,
  Text,
  Divider,
  Button,
} from '@chakra-ui/react'
import React, { useEffect, useMemo } from 'react'
import useDelegations from './hooks/useDelegations'
import usePagination from '@/hooks/usePagination'
import Delegator from './Delegator'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { useAssetBySymbol } from '@/hooks/useAssets'
import useDelegateState from './hooks/useDelegateState'
import { num, shiftDigits } from '@/helpers/num'
import useUpdateDelegation from './hooks/useUpdateDelegation'
import ConfirmModal from '../ConfirmModal'
import TxError from '../TxError'
import { Summary } from './Summary'
import useStaked from '../Stake/hooks/useStaked'

type Props = {}

type ValidatorProps = {
  delegator: any
  mbrnBalance: string
}

const Validator = ({ delegator, mbrnBalance }: ValidatorProps) => {
  const { name, amount, socials, address } = delegator
  const { delegateState, setDelegateState } = useDelegateState()
  const { delegations = [] } = delegateState || {}
  const existingDelegation = delegations?.find((delegation) => delegation.address === address)
  const { data: staked } = useStaked()

  const totalBalance = useMemo(() => {
    if (!staked) return amount
    const stakedAmount = shiftDigits(staked?.staked.total_staked, -6)

    return num(amount).plus(stakedAmount).toNumber()
  }, [staked, amount])

  const onChange = (value: number) => {
    const newAmount = num(value).minus(amount).toNumber()
    const newDelegations = delegations?.map((delegation) => {
      if (delegation.address === address) {
        return {
          ...delegator,
          ...delegation,
          amount,
          newAmount,
        }
      }
      return delegation
    })

    // remaining balance is sum of newAmounts in delegations
    const remainingBalance = newDelegations.reduce(
      (acc, delegation) =>
        num(delegation.newAmount).isGreaterThan(0)
          ? num(acc).minus(Math.abs(delegation.newAmount)).toNumber()
          : num(acc).plus(Math.abs(delegation.newAmount)).toNumber(),
      num(mbrnBalance).toNumber(),
    )

    if (!existingDelegation) {
      newDelegations.push({ name, amount, newAmount, address, socials })
    }
    setDelegateState({ remainingBalance, delegations: newDelegations })
  }

  return (
    <Stack w="full">
      <HStack w="full" justifyContent="space-between">
        <Delegator name={name} address={address} socials={socials} />
        <Text variant="value">
          {num(amount)
            .plus(existingDelegation?.newAmount || 0)
            .toNumber()}
        </Text>
      </HStack>

      <Slider
        aria-label="slider-ex-4"
        defaultValue={0}
        value={num(amount)
          .plus(existingDelegation?.newAmount || 0)
          .toNumber()}
        min={0}
        max={totalBalance}
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

const DelegateList = (props: Props) => {
  const { data = [] } = useDelegations()
  const mbrn = useAssetBySymbol('MBRN')
  const mbrnBalance = useBalanceByAsset(mbrn)
  const updateDelegation = useUpdateDelegation()
  // const { setDelegateState } = useDelegateState()

  // useEffect(() => {
  //   setDelegateState({ remainingBalance: mbrnBalance })
  // }, [mbrnBalance])

  const { paginatedData, nextPage, previousPage, currentPage, totalPages } = usePagination<any>(
    data,
    4,
  )

  return (
    <Stack w="full">
      <Stack minH="230px">
        {paginatedData.map((delegator) => (
          <Validator key={delegator?.name} delegator={delegator} mbrnBalance={mbrnBalance} />
        ))}
      </Stack>

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

      <Divider
        bg="rgba(226, 216, 218, 0.24)"
        boxShadow="0px 0px 8px 0px rgba(226, 216, 218, 0.64)"
        h="1px"
        my="5"
      />

      <Stack w="full">
        <HStack w="full" justifyContent="space-between">
          <Text variant="value" textTransform="none">
            Your commision as delegation
          </Text>
          <Text variant="value">10</Text>
        </HStack>

        <Slider aria-label="slider-ex-4" defaultValue={30}>
          <SliderTrack bg="#E2D8DA" h="2" borderRadius="80px">
            <SliderFilledTrack bg="#C445F0" />
          </SliderTrack>
          <SliderThumb boxSize={6} bg="#C445F0" cursor="grab" border="2px solid #E2D8DA" />
        </Slider>
      </Stack>

      <ConfirmModal label={'Update delegation'} action={updateDelegation}>
        <Summary />
        <TxError action={updateDelegation} />
      </ConfirmModal>
    </Stack>
  )
}

export default DelegateList
