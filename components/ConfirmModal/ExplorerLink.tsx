import { Text, HStack, Link } from '@chakra-ui/react'
import React, { useMemo } from 'react'
import useWallet from '@/hooks/useWallet'
import { colors } from '@/config/defaults'
import { getTxExplorerUrl } from '@/helpers/explorer'

export const ExplorerLink = ({ txHash }: { txHash: string | undefined }) => {
  const { chain } = useWallet()

  if (!txHash) return null

  const txLink = getTxExplorerUrl(chain, txHash)

  if (!txLink) return null

  const first4 = txHash.slice(0, 4)
  const last4 = txHash.slice(-4)

  return (
    <HStack justifyContent="space-between">
      <Text fontWeight="bold" fontSize="xs" color="white">
        Transaction hash
      </Text>
      <Link isExternal href={txLink} style={{ margin: 'unset' }} fontSize="xs" color={colors.link}>
        {`${first4}...${last4}`}
      </Link>
    </HStack>
  )
}
