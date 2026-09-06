import React, { forwardRef } from 'react'

import {
  CARD_HEIGHT,
  CARD_WIDTH,
  ShareCardVenue,
  buildShareCardModel,
} from './radarShareCardModel'

/**
 * Off-screen 1200x675 share card for a radar result — the same visual language
 * as the venue weather cards (scripts/make-share-card.mjs): bone-on-black,
 * serif headline, mono numbers, provenance footer so the image self-documents.
 * Rendered off-viewport and exported via services/shareableCard
 * exportElementAsImage (html-to-image). Inline styles on purpose: the export
 * must not depend on external stylesheets (CORS) or theme context. Content
 * comes from buildShareCardModel (JSX-free, unit-tested); this is the shell.
 */

export interface RadarShareCardProps {
  totalUsdText: string
  heldCount: number
  venues: ShareCardVenue[]
  dateText: string
}

const MONO = "'JetBrains Mono', 'SFMono-Regular', Menlo, monospace"

export const RadarShareCard = forwardRef<HTMLDivElement, RadarShareCardProps>(
  function RadarShareCard(props, ref) {
    const model = buildShareCardModel(props)
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
                fontSize: 50,
                lineHeight: 1.15,
                marginTop: 24,
                maxWidth: 1000,
              }}
            >
              {model.headline}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {model.rows.map((v) => (
              <div key={v.label} style={{ display: 'flex', alignItems: 'baseline', gap: 24 }}>
                <div style={{ width: 130, fontSize: 20, color: '#ece6d8', flexShrink: 0 }}>{v.label}</div>
                <div
                  style={{
                    width: 110,
                    fontSize: 14,
                    letterSpacing: '0.18em',
                    textTransform: 'uppercase',
                    color: v.color,
                    flexShrink: 0,
                  }}
                >
                  {v.verdict}
                </div>
                <div style={{ fontSize: 17, color: '#8d877b', lineHeight: 1.4 }}>{v.reason}</div>
              </div>
            ))}
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

export default RadarShareCard
