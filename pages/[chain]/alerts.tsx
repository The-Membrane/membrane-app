import React from 'react'

import PageSeo from '@/components/PageSeo'
import { AlertSettings } from '@/components/Alerts/AlertSettings'

const AlertsPage = () => (
  <>
    <PageSeo
      seoClass="app"
      title="Membrane | Your alerts"
      description="Choose and sign your Membrane alert preferences. Personal delivery is gated on verified onchain sources and confirmed channels."
    />
    <AlertSettings />
  </>
)

export default AlertsPage
