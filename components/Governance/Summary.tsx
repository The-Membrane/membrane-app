import { num } from '@/helpers/num'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { Asset } from '@chain-registry/types'
import { Badge, HStack, Image, Stack, Text } from '@chakra-ui/react'
import useDelegateState from './hooks/useDelegateState'

type SummaryItemProps = Partial<Asset> & {
  label: string
  amount?: string | number
  showBadge?: boolean
  badge?: string
  logo?: string
  deleagtionName?: string
}

const SummaryItem = ({
  label,
  amount = 0,
  badge,
  showBadge = true,
  logo,
  deleagtionName,
}: SummaryItemProps) => (
  <HStack
    key={label}
    justifyContent="space-between"
    pb="1"
    my="1"
    borderBottom="1px solid"
    borderColor="whiteAlpha.200"
  >
    <HStack>
      <HStack>
        <Image src={logo} w="20px" h="20px" />
        <Text variant="value" textTransform="unset">
          {label}
        </Text>
      </HStack>

      {showBadge && (
        <Badge fontSize="10px" colorScheme="green">
          {badge}
        </Badge>
      )}
      <Text variant="value" textTransform="unset">
        {num(amount).isGreaterThan(0) ? 'to ' : 'from '}
        {deleagtionName}
      </Text>
    </HStack>
    <HStack>
      <Text>{num(amount).abs().toString()}</Text>
    </HStack>
  </HStack>
)

export const Summary = () => {
  const { delegateState } = useDelegateState()
  const mbrn = useAssetBySymbol('MBRN')

  return (
    <Stack h="max-content" overflow="auto" w="full">
      {delegateState?.delegations?.map((delegation) => (
        <SummaryItem
          key={delegation.address}
          label={mbrn?.symbol!}
          deleagtionName={delegation.name}
          amount={delegation.newAmount}
          badge={num(delegation.newAmount).isGreaterThan(0) ? 'Delegate' : 'Undelegate'}
          logo={mbrn?.logo}
        />
      ))}
    </Stack>
  )
}
