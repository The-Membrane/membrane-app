import AcquisitionDashboard from '@/components/AcquisitionDashboard/AcquisitionDashboard'
import PageSeo from '@/components/PageSeo'

const AcquisitionDashboardPage = () => (
  <>
    {/* Rule 0 (docs/SEO_RULESET.md): internal — internal MBRN acquisition metrics dashboard */}
    <PageSeo
      seoClass="internal"
      title="Membrane — Acquisition Dashboard"
      description="Internal dashboard tracking MBRN token supply over time, current acquisition window statistics, the phase timeline, and historical deposit charts."
    />
    <AcquisitionDashboard />
  </>
)

export default AcquisitionDashboardPage
