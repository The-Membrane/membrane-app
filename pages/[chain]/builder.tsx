import React from 'react'

import PageSeo from '@/components/PageSeo'
import { Builder } from '@/components/Builder'

// Carry Builder — the always-on practice/gauntlet surface (port of proto/builder.html).
// No wallet gate by design: the page is fully usable without a connection, so there is
// no DemoBanner or connect CTA here; fixture-driven blocks carry MockStamp instead.
const BuilderPage = () => {
  return (
    <>
      <PageSeo
        seoClass="app"
        title="Membrane — Carry Builder"
        description="Build a carry position on a factory board, then sweep it through a daily-seeded fifteen-floor gauntlet. Floors survived and bitcoin kept rank; gross yield never does."
      />
      <Builder />
    </>
  )
}

export default BuilderPage
