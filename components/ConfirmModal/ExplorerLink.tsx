import { Text, HStack, Link } from '@chakra-ui/react'
import React, { useMemo } from 'react'
import useWallet from '@/hooks/useWallet'
import { colors } from '@/config/defaults'

type Explorer = {
  name?: string
  kind?: string
  url?: string
  tx_page?: string
  account_page?: string
}

export const getExplorer = (chain: any | undefined) => {
  const priorityOrder = ['celatone', 'mintscan', 'atomscan']
  const explorers: Explorer[] = chain?.explorers || []
  return explorers
    .filter((explorer: Explorer) => !!explorer?.kind)
    .sort((a: Explorer, b: Explorer) => {
      const aIndex = priorityOrder.indexOf(a?.kind || '')
      const bIndex = priorityOrder.indexOf(b?.kind || '')
      const ai = aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex
      const bi = bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex
      return ai - bi
    })
}

export const ExplorerLink = ({ txHash }: { txHash: string | undefined }) => {
  const { chain } = useWallet()

  if (!txHash) return null

  // TODO(evm-migration): EVM block explorers expose /tx/<hash>; the base URL comes from the
  // viem Chain's blockExplorers config (config/evm/chains.ts). Was: Cosmos chain.explorers
  // priority list + celat.one neutron special-casing (see getExplorer above).
  const baseUrl = chain?.blockExplorers?.default?.url
  const txLink = baseUrl ? `${baseUrl.replace(/\/$/, '')}/tx/${txHash}` : undefined

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
