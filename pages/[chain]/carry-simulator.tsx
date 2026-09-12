import React from 'react'

import PageSeo from '@/components/PageSeo'
import { Simulator } from '@/components/Simulator'

// CARRY-FIRST SIMULATOR — the same simulator as /simulator, opened on a live mainnet
// carry and led by the bill rather than the liquidation verdict (owner ruling
// 2026-09-12: keep both builds, flip between them with one constant in
// config/simulatorMode.ts). Indexable, exactly like its sibling.
const CarrySimulatorPage = () => (
  <>
    <PageSeo
      seoClass="indexable"
      title="Membrane — Carry Simulator"
      description="See what a lending protocol charges a deployed carry every year in fixed interest, and how the same position survives the measured October 2025 crash on Membrane, where the cost is paid out of the venue's yield and never exceeds it."
    />
    <Simulator mode="carry" />
  </>
)

export default CarrySimulatorPage
