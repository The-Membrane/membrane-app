import { Coin } from '@cosmjs/stargate'
import { getAssetByDenom } from '@/helpers/chain'
import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'
import { Asset } from '@chain-registry/types'
import { Badge, HStack, Image, Stack, Text } from '@chakra-ui/react'
import { colors } from '@/config/defaults'
import { useChainRoute } from '@/hooks/useChainRoute'

type SummaryItemProps = Partial<Asset> & {
  label: string
  amount?: string | number
  showBadge?: boolean
  badge?: string
  logo?: string
  asset?: Asset
}

const SummaryItem = ({
  label,
  amount = 0,
  badge,
  showBadge = true,
  logo,
  asset,
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
        {asset?.isLP ? (
          <HStack>
            <Image src={asset?.logos?.[0]} w="24px" h="24px" />
            <Image src={asset?.logos?.[1]} w="24px" h="24px" ml="-16px" />
          </HStack>
        ) : (
          <Image src={asset?.logo} w="24px" h="24px" />
        )}
        <Text variant="value" textTransform="unset">
          {label}
        </Text>
      </HStack>

      {showBadge && (
        <Badge fontSize="10px" colorScheme={colors.summaryScheme}>
          {badge}
        </Badge>
      )}
    </HStack>
    <HStack>
      <Text>{num(amount).abs().toString()}</Text>
    </HStack>
  </HStack>
)

type Props = {
  claims?: Coin[]
}

export const ClaimSummary = ({ claims = [] }: Props) => {
  return (
    <Stack h="max-content" overflow="auto" w="full">
      {claims
        .filter((a) => num(a.amount).isGreaterThan(0))
        .map((claim) => {
          const { chainName } = useChainRoute()
          const asset = getAssetByDenom(claim.denom, chainName)
          const amount = shiftDigits(
            claim.amount,
            -asset?.decimal!,
          ).toNumber()
          return (
            <SummaryItem
              key={claim.denom}
              label={asset?.symbol!}
              amount={amount}
              badge="Claim"
              asset={asset}
            />
          )
        })}
    </Stack>
  )
}
