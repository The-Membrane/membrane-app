import { shiftDigits } from '@/helpers/math'
import { useAssetBySymbol } from '@/hooks/useAssets'
import {
  Box,
  Card,
  Image,
  Stack,
  Table,
  TableContainer,
  Tbody,
  Td,
  Text,
  Tr,
} from '@chakra-ui/react'
import useAllocations from './hooks/useAllocation'
import { num } from '@/helpers/num'

type Props = {}

const TokenAllocation = (props: Props) => {
  const { data: allocations } = useAllocations()
  const mbrnAsset = useAssetBySymbol('MBRN')

  const { unlocked, amount } = allocations || {}

  const allocationAmount = shiftDigits(Number(amount || 0), -6).toString()
  const unlockedAmount = unlocked === '0' ? 0 : shiftDigits(Number(unlocked || 0), -6).toString()

  if (num(amount).isZero()) return null

  return (
    <Card w="full" p="8" alignItems="center" gap={5} h="full" justifyContent="space-between">
      <Text variant="title" fontSize="24px">
        Token Allocation
      </Text>

      <Stack alignItems="center">
        <Box boxSize="10">
          <Image src={mbrnAsset?.logo} alt="MBRN" />
        </Box>

        <TableContainer>
          <Table variant="simple">
            <Tbody>
              <Tr>
                <Td>Allocations</Td>
                <Td isNumeric color="primary.200">
                  {allocationAmount}
                </Td>
              </Tr>
              <Tr>
                <Td>Withdrawable</Td>
                <Td isNumeric color="primary.200">
                  {unlockedAmount}
                </Td>
              </Tr>
            </Tbody>
          </Table>
        </TableContainer>
      </Stack>
    </Card>
  )
}

export default TokenAllocation
