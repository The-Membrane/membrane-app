import type {NextApiRequest, NextApiResponse} from 'next'
import {buildCloudHolderFixture} from '@/scripts/research/forecasting-cloud-holder-fixture'

// Isolated acceptance transport. These are synthetic current reads, never live evidence.
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (process.env.MEMBRANE_CLOUD_ACCEPTANCE !== 'fixture') return res.status(404).end()
  if (req.method !== 'GET') return res.status(405).end()
  const variant = req.query.variant
  if (!['adequate', 'below', 'censored'].includes(String(variant))) return res.status(400).end()
  const props = buildCloudHolderFixture(variant === 'adequate' ? '1000000' : '200000')
  const model = props.holderAssessment!.nativeCashHolderOutlook!
  if (variant === 'adequate') {
    for (const scenario of model.process.scenarios) {
      scenario.status = 'conditional_path'; scenario.targetHeadroomRaw = '1'; scenario.sampledShortfalls = []
    }
  }
  if (variant === 'censored') {
    for (const scenario of model.process.scenarios) {
      scenario.status = 'censored_path'; scenario.targetHeadroomRaw = null
      scenario.points = scenario.points.slice(0, 2); scenario.sampledShortfalls = []
    }
    model.process.targetSummary = null
    model.shrinkingAlert.shrinkingScenarios = 0
    model.shrinkingAlert.usableScenarios = 0
    model.shrinkingAlert.censoredScenarios = model.process.scenarios.length
  }
  // Server-private receipt objects cannot cross JSON. The page retains its own response.
  delete props.holderAssessment!.nativeCashHolderOutlookIssue
  return res.status(200).json({fixtureKind: 'audited-history-synthetic-current-and-scenario', props})
}
