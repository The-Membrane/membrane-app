import { getAssetLogo } from '@/helpers/chain'
import { num } from '@/helpers/num'
import { Asset } from '@chain-registry/types'
import { Badge, HStack, Image, Stack, Text } from '@chakra-ui/react'
import useStakeState from './hooks/useStakeState'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { SPACING } from '@/config/spacing'

type SummaryItemProps = Partial<Asset> & {
  label: string
  amount?: string | number
  showBadge?: boolean
  badge?: string
  logo?: string
}

const SummaryItem = ({ label, amount = 0, badge, showBadge = true, logo }: SummaryItemProps) => (
  <HStack
    key={label}
    justifyContent="space-between"
    pb={SPACING.xs}
    my={SPACING.xs}
    borderBottom="1px solid"
    borderColor={SEMANTIC_COLORS.borderSubtle}
  >
    <HStack>
      <HStack>
        <Image src={logo} w="20px" h="20px" />
        <Text variant="value" textTransform="unset">
          {label}
        </Text>
      </HStack>

      {showBadge && (
        <Badge fontSize={TYPOGRAPHY.label} colorScheme="green">
          {badge}
        </Badge>
      )}
    </HStack>
    <HStack>
      <Text>{num(amount).abs().toString()}</Text>
    </HStack>
  </HStack>
)

export const Summary = () => {
  const { stakeState } = useStakeState()
  const { asset } = stakeState
  // TODO(evm-migration): stakeState.asset is the legacy @chain-registry Asset; getAssetLogo expects the EVM helpers/chain Asset.
  const logo = getAssetLogo(asset as any)

  return (
    <Stack h="max-content" overflow="auto" w="full">
      <SummaryItem
        label={asset?.symbol!}
        badge={stakeState?.txType}
        amount={stakeState.amount}
        logo={logo}
      />
    </Stack>
  )
}
