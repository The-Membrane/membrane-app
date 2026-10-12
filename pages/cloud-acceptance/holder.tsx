import React, {useEffect, useState} from 'react'
import type {GetServerSideProps} from 'next'
import {ExitPressureCard, type ExitPressureCardProps} from '@/components/Carry/ExitPressureCard'
import {retainNativeCashHolderOutlook} from '@/lib/carry/nativeCashHolderOutlookReceipt'

export const getServerSideProps: GetServerSideProps = async () =>
  process.env.MEMBRANE_CLOUD_ACCEPTANCE === 'fixture' ? {props: {}} : {notFound: true}

export default function HolderAcceptance() {
  const [variant, setVariant] = useState('censored')
  const [props, setProps] = useState<ExitPressureCardProps | null>(null)
  const [mutation, setMutation] = useState('none')
  useEffect(() => {
    const abort = new AbortController()
    setProps(null); setMutation('none')
    fetch(`/api/carry/cloud-acceptance-holder?variant=${variant}`, {signal: abort.signal})
      .then(async response => {
        const body = await response.json()
        if (!response.ok || body.fixtureKind !== 'audited-history-synthetic-current-and-scenario') throw new Error('Fixture unavailable')
        const p = body.props as ExitPressureCardProps, a = p.holderAssessment!
        a.nativeCashHolderOutlookIssue = retainNativeCashHolderOutlook(a.nativeCashHolderOutlook!, response.status, {
          routeKey: p.routeKey, destination: p.destination, owner: p.requestedHolderAddress!,
          requestedRaw: p.requestedRaw!, asset: p.requestedAssetAddress!, assetDecimals: p.requestedAssetDecimals!,
          horizonHours: p.horizonHours, source: a.source, asOfMs: p.asOfMs,
        })
        if (!a.nativeCashHolderOutlookIssue) throw new Error('Fixture retention failed')
        setProps(p)
      }).catch(error => {if (!abort.signal.aborted) console.error(error)})
    return () => abort.abort()
  }, [variant])
  const selected = props && {...props,
    ...(mutation === 'owner' ? {requestedHolderAddress: '0x0000000000000000000000000000000000000002'} : {}),
    ...(mutation === 'amount' ? {requestedRaw: '1000001'} : {}),
    ...(mutation === 'horizon' ? {horizonHours: 24} : {}),
  }
  return <main>
    <h1>Cloud acceptance fixture</h1>
    <p>Synthetic current reads and scenarios; audited historical samples. No live provider qualification.</p>
    <label>Scenario <select aria-label="Scenario" value={variant} onChange={e => setVariant(e.target.value)}>
      <option value="censored">Current shortfall, future censored</option><option value="adequate">Adequate samples</option><option value="below">Below requested exit</option>
    </select></label>
    <label>Selection <select aria-label="Selection" value={mutation} onChange={e => setMutation(e.target.value)}>
      <option value="none">Original request</option><option value="owner">Different owner</option><option value="amount">Different amount</option><option value="horizon">Different horizon</option>
    </select></label>
    {selected ? <section data-testid="actual-holder-card"><ExitPressureCard {...selected}/></section> : <p>Loading fixture</p>}
  </main>
}
