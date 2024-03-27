import { Text, HStack, Link } from '@chakra-ui/react'
import React, { useMemo } from 'react'
import useWallet from '@/hooks/useWallet'

type Explorer = {
  name?: string
  kind?: string
  url?: string
  tx_page?: string
  account_page?: string
}

export const getExplorer = (chain: any | undefined) => {
  const explorerOrder = ['mintscan', 'atomscan'].reverse()
  return (
    chain?.explorers!.sort(
      (a: Explorer, b: Explorer) =>
        explorerOrder.indexOf(b?.kind!) - explorerOrder.indexOf(a?.kind!),
    ) || []
  )
}

export const ExplorerLink = ({ txHash }: { txHash: string | undefined }) => {
  const { chain } = useWallet()
  const [explorer] = useMemo(() => getExplorer(chain), [chain])

  const first4 = txHash?.slice(0, 4)
  const last4 = txHash?.slice(-4)
  const txLink = eval('`' + explorer?.tx_page + '`')

  if (!txHash) return null

  return (
    <HStack justifyContent="space-between">
      <Text fontWeight="bold" fontSize="xs" color="white">
        Transaction hash
      </Text>
      <Link isExternal href={txLink} style={{ margin: 'unset' }} fontSize="xs" color="primary.500">
        {[first4, last4].join('...')}
      </Link>
    </HStack>
  )
}
