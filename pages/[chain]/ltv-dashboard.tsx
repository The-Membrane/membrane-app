import LTVDashboard from '@/components/LTVDashboard/LTVDashboard'
import PageSeo from '@/components/PageSeo'

const LTVDashboardPage = () => (
  <>
    {/* Rule 0 (docs/SEO_RULESET.md): internal — mock-data LTV history dashboard */}
    <PageSeo
      seoClass="internal"
      title="Membrane — LTV Dashboard"
      description="Dashboard displaying historical loan-to-value data for collateral assets, including current and pending LTV, direction of change, built on mock demo data."
    />
    <LTVDashboard />
  </>
)

export default LTVDashboardPage
