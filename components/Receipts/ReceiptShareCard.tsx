import React, { forwardRef } from 'react'

import {
  CARD_HEIGHT,
  CARD_WIDTH,
  buildReceiptCardModel,
} from './receiptShareCardModel'

/**
 * Off-screen 1200x675 share card for a SCORED receipt — the same visual language
 * as the radar / venue-weather cards (bone-on-black, serif headline, mono
 * numbers, provenance footer). Rendered off-viewport and exported via
 * services/shareableCard.exportElementAsImage (html-to-image). Inline styles on
 * purpose: the export must not depend on external stylesheets (CORS) or theme
 * context. Content comes from buildReceiptCardModel (JSX-free, unit-tested); this
 * is the shell.
 */

export interface ReceiptShareCardProps {
  statement: string
  hit: boolean
  realized: number
  bandLow: number
  bandHigh: number
  scoredAtText: string
}

const MONO = "'JetBrains Mono', 'SFMono-Regular', Menlo, monospace"

export const ReceiptShareCard = forwardRef<HTMLDivElement, ReceiptShareCardProps>(
  function ReceiptShareCard(props, ref) {
    const model = buildReceiptCardModel(props)
    return (
      <div style={{ position: 'absolute', left: '-12000px', top: 0 }} aria-hidden>
        <div
          ref={ref}
          data-card-element
          style={{
            width: CARD_WIDTH,
            height: CARD_HEIGHT,
            background: '#09090a',
            color: '#ece6d8',
            fontFamily: MONO,
            padding: '64px 72px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            boxSizing: 'border-box',
          }}
        >
          <div>
            <div style={{ fontSize: 15, letterSpacing: '0.28em', color: '#8d877b', textTransform: 'uppercase' }}>
              {model.eyebrow}
            </div>
            <div
              style={{
                fontFamily: "Georgia, 'Times New Roman', serif",
                fontSize: 44,
                lineHeight: 1.2,
                marginTop: 24,
                maxWidth: 1040,
              }}
            >
              {model.headline}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'baseline', gap: 28 }}>
            <div
              style={{
                fontSize: 64,
                letterSpacing: '0.06em',
                color: model.verdictColor,
                fontWeight: 700,
              }}
            >
              {model.verdict}
            </div>
            <div style={{ fontSize: 22, color: '#ece6d8' }}>{model.outcomeLine}</div>
          </div>

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              borderTop: '1px solid rgba(236,230,216,0.10)',
              paddingTop: 22,
              fontSize: 14,
              color: '#56524a',
              letterSpacing: '0.08em',
            }}
          >
            <span>{model.footerLeft}</span>
            <span>{model.footerRight}</span>
          </div>
        </div>
      </div>
    )
  },
)

export default ReceiptShareCard
