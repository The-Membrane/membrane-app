import { TxButton } from '@/components/TxButton'
import { Asset } from '@/contracts/codegen/vesting/Vesting.types'
import { getAssetByDenom } from '@/helpers/chain'
import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'
import { useAssetBySymbol } from '@/hooks/useAssets'
import {
  Box,
  Card,
  HStack,
  Image,
  Stack,
  Table,
  TableContainer,
  Tbody,
  Td,
  Text,
  Tr,
} from '@chakra-ui/react'
import useAllocation from './hooks/useAllocation'
import useClaimFees from './hooks/useClaimFees'
import useWithdrawUnlocked from './hooks/useWithdrawUnlocked'

type Props = {}

type ClaimAssetProps = {
  claimable: Asset
}

const ClaimAsset = ({ claimable }: ClaimAssetProps) => {
  const asset = getAssetByDenom(claimable.info.native_token.denom)
  return (
    <Tr>
      <Td>
        <HStack>
          <Image src={asset?.logo} alt={asset?.symbol} w="5" h="5" />
          <Text>{asset?.symbol}</Text>
        </HStack>
      </Td>
      <Td isNumeric color="primary.200">
        {shiftDigits(Number(claimable.amount), -asset?.decimal!).toString()}
      </Td>
    </Tr>
  )
}

const TokenAllocation = (props: Props) => {
  const { data: allocations } = useAllocation()
  const mbrnAsset = useAssetBySymbol('MBRN')
  const { unlocked, allocation, claimables } = allocations || {}
  const { action: claimFees } = useClaimFees()
  const withdraw = useWithdrawUnlocked()

  const allocationAmount = shiftDigits(Number(allocation?.amount || 0), -6).toString()
  const unlockedAmount = unlocked === '0' ? 0 : shiftDigits(Number(unlocked || 0), -6).toString()

  if (num(allocation?.amount).isZero()) return null

  return (
    <Card p="8" alignItems="center" gap={8} h="full" justifyContent="space-between" maxW="600px">
      <Text variant="title" fontSize="24px" alignSelf="flex-start">
        Token Allocation
      </Text>

      <Stack alignItems="center" bg="blackAlpha.300" borderRadius="lg" p="5" minW="300px">
        <Box boxSize="10">
          <Image src={mbrnAsset?.logo} alt="MBRN" />
        </Box>

        <HStack gap="5" w="full" justifyContent="space-between">
          <Text>Allocated</Text>
          <Text color="primary.200">{allocationAmount}</Text>
        </HStack>

        <HStack gap="5" w="full" justifyContent="space-between">
          <Text>Unlocked</Text>
          <Text color="primary.200">{unlockedAmount}</Text>
        </HStack>

        <TxButton
          mt={4}
          maxW="300px"
          isDisabled={num(unlockedAmount).isZero()}
          isLoading={withdraw.isPending}
          onClick={() => withdraw.mutate()}
        >
          Withdraw unlocked
        </TxButton>
      </Stack>

      <Stack alignItems="center" bg="blackAlpha.300" borderRadius="lg" p="5" minW="300px">
        <Text fontSize="lg">Claimable Assets</Text>
        <TableContainer>
          <Table variant="unstyled">
            <Tbody>
              {claimables?.map((claimable) => (
                <ClaimAsset key={claimable.info.native_token.denom} claimable={claimable} />
              ))}
            </Tbody>
          </Table>
        </TableContainer>

        {!claimables?.length && (
          <Text color="gray.400" fontSize="sm" textAlign="center">
            No claimable assets
          </Text>
        )}

        <TxButton
          mt={4}
          maxW="300px"
          isLoading={claimFees?.simulate.isLoading || claimFees?.tx.isPending}
          isDisabled={claimFees?.simulate.isError || !claimFees?.simulate.data}
          onClick={() => claimFees?.tx.mutate()}
        >
          Claim
        </TxButton>
      </Stack>
    </Card>
  )
}

export default TokenAllocation
