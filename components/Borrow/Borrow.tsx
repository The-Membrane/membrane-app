import React, { useMemo, useState } from 'react'
import { Box, Text } from '@chakra-ui/react'

import { DemoBanner, MockStamp } from '@/components/demo'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { useChainRoute } from '@/hooks/useChainRoute'

import { WalletStrip } from './WalletStrip'
import { MintPanel } from './MintPanel'
import { CureTimeline } from './CureTimeline'
import { CarryCrossSell } from './CarryCrossSell'
import { ConfirmSheet } from './ConfirmSheet'
import { OracleCard } from './OracleCard'
import { RATE, WALLET, ORACLE_CARDS } from './fixtures'
import { useLiveMarketData } from './hooks/useLiveMarketData'
import { computeBorrowMath, defaultPostAmount, fmt, fmtAmount } from './utils'
import type { ExecSheetData } from './types'

/**
 * Borrow — post collateral, mint CDT. Ported from public/proto/borrow.html
 * end-to-end: the wallet strip, mint form, breach/cure/liquidation
 * explainer, and the Carry cross-sell, wired to useDemoMode/DemoAwareCta
 * instead of the proto's localStorage connect seam.
 */
export const Borrow: React.FC = () => {
  const { chainName } = useChainRoute()
  const { overrides, liveLabels } = useLiveMarketData()

  const [selectedIndex, setSelectedIndex] = useState(0)
  const [postAmount, setPostAmount] = useState(() => defaultPostAmount(WALLET[0]))
  const [ltv, setLtv] = useState(40)
  const [oracleSym, setOracleSym] = useState<string | null>(null)
  const [execData, setExecData] = useState<ExecSheetData | null>(null)
  const [isSheetOpen, setIsSheetOpen] = useState(false)

  // Live overlay merges over the WALLET fixture — never mutates it, and every
  // fetch that hasn't resolved (or failed) just leaves the fixture value.
  const assets = useMemo(
    () =>
      WALLET.map((a) => ({
        ...a,
        px: overrides.px[a.sym] ?? a.px,
        yld: overrides.yld[a.sym] ?? a.yld,
        vol: overrides.vol[a.sym] ?? a.vol,
      })),
    [overrides]
  )

  const asset = assets[selectedIndex]
  const math = useMemo(() => computeBorrowMath(asset, postAmount, ltv, RATE), [asset, postAmount, ltv])

  const handleSelect = (index: number) => {
    setSelectedIndex(index)
    setPostAmount(defaultPostAmount(assets[index]))
  }

  const handleMax = () => {
    setPostAmount(asset.bal.toFixed(Math.min(asset.dp, 4)))
  }

  const handleBorrow = () => {
    setExecData({
      title: `Borrow — mint CDT against ${asset.sym}`,
      rows: [
        ['You post', `${fmtAmount(math.postValue, asset.dp)} ${asset.sym} (${fmt(math.pv)})`],
        ['You mint', `${fmt(math.mint)} CDT — to your wallet`],
        ['Your LTV', `${math.effectiveLtv.toFixed(0)}% · cap ${math.ltvCapPercent}% · line ${(asset.M * 100).toFixed(0)}%`],
        ['Breach odds, 12 months', math.odds < 1 ? 'under 1%' : `${math.odds.toFixed(math.odds < 10 ? 1 : 0)}%`],
        [
          'Cost of the debt, today',
          `${RATE.toFixed(1)}% / yr${math.net < 0 ? '' : ` · collateral earns ${asset.yld.toFixed(1)}%`}`,
        ],
      ],
      note:
        'The CDT is minted to your wallet and deployed nowhere. Repay anytime to unlock the collateral. A breach opens an 8-hour cure window; liquidation repays to the cap, not to zero.',
      cta: 'Sign & mint',
      done: 'CDT in wallet',
    })
    setIsSheetOpen(true)
  }

  return (
    <Box maxW="1140px" mx="auto" px={SPACING.base} pb={SPACING['3xl']}>
      <DemoBanner note="wallet-scoped numbers are a demo wallet, not yours — live market data stays live" />

      <Box mt={SPACING.lg}>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          letterSpacing="0.28em"
          textTransform="uppercase"
          color={SEMANTIC_COLORS.textSecondary}
        >
          Borrow
        </Text>
        <Text as="h1" fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h1} color={SEMANTIC_COLORS.textPrimary} mt={SPACING.xs}>
          Mint CDT against what you already hold.
        </Text>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textTertiary} mt={SPACING.xs} lineHeight={1.7} maxW="72ch">
          Plain debt. The CDT arrives in your wallet and does nothing until you spend or deploy it. The version
          where the debt earns its own interest is Carry.
        </Text>
      </Box>

      <MockStamp label={liveLabels.length ? `live: ${liveLabels.join(' · ')}` : 'mock wallet'} display="block" mt={SPACING.sm} />

      <WalletStrip assets={assets} selectedIndex={selectedIndex} onSelect={handleSelect} onOracleClick={setOracleSym} />

      <MintPanel
        asset={asset}
        rate={RATE}
        postAmount={postAmount}
        onPostAmountChange={setPostAmount}
        onMax={handleMax}
        ltv={ltv}
        onLtvChange={setLtv}
        math={math}
        onBorrow={handleBorrow}
      />

      <CureTimeline />
      <CarryCrossSell chainName={chainName} />

      <ConfirmSheet isOpen={isSheetOpen} onClose={() => setIsSheetOpen(false)} data={execData} />
      <OracleCard entry={oracleSym ? ORACLE_CARDS[oracleSym] ?? null : null} isOpen={!!oracleSym} onClose={() => setOracleSym(null)} />
    </Box>
  )
}

export default Borrow
