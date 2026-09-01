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
