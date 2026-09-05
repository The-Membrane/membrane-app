import Lockdrop from '@/components/Lockdrop'
import PageSeo from '@/components/PageSeo'

const LockdropPage = () => {
  return (
    <>
      {/* Rule 0 (docs/SEO_RULESET.md): internal — legacy event page */}
      <PageSeo
        seoClass="internal"
        title="Membrane — Lockdrop"
        description="Legacy Membrane lockdrop page showing lock information, a historical lock chart, and token allocation details for participants who locked deposits."
      />
      <Lockdrop />
    </>
  )
}

export default LockdropPage
