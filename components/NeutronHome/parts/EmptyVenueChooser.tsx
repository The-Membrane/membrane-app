import React, { useMemo, useState } from 'react'
import { VenueSlotIndex } from '../types'

export const EmptyVenueChooser = ({
    options = ['Venue Type 1', 'Venue Type 2', 'Venue Type 3'],
    initialSlot = 3,
    onPlacementSelect,
}: {
    options?: string[]
    initialSlot?: VenueSlotIndex
    onPlacementSelect: (slot: VenueSlotIndex, option: string) => void
}) => {
    const [idx, setIdx] = useState<number>(0)
    const [slot, setSlot] = useState<VenueSlotIndex>(initialSlot)
    const current = useMemo(() => options[Math.max(0, Math.min(options.length - 1, idx))], [idx, options])

    return (
        <div style={{ gridColumn: '1 / -1' }}>
            <div style={{ height: 160, borderRadius: 14, border: '1px solid #2b2f47', background: '#0d0f1a', padding: 16, display: 'grid', gridTemplateColumns: '48px 1fr 48px', alignItems: 'center', gap: 12 }}>
                <button aria-label="Prev option" onClick={() => setIdx(i => (i - 1 + options.length) % options.length)} style={{ padding: 8, borderRadius: 10, background: '#101731', border: '1px solid #2b2f47' }}>{'‹'}</button>
                <div style={{ textAlign: 'center' }}>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>Select Venue Type</div>
                    <div style={{ opacity: 0.85 }}>{current}</div>
                </div>
                <button aria-label="Next option" onClick={() => setIdx(i => (i + 1) % options.length)} style={{ padding: 8, borderRadius: 10, background: '#101731', border: '1px solid #2b2f47' }}>{'›'}</button>
            </div>
            <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
                {([1, 2, 3, 4, 5] as VenueSlotIndex[]).map(s => (
                    <button key={s}
                        onClick={() => setSlot(s)}
                        aria-pressed={slot === s}
                        style={{ width: 34, height: 34, borderRadius: 10, background: slot === s ? '#112235' : '#0f1424', border: `1px solid ${slot === s ? '#2dc5ff' : '#2b2f47'}`, color: 'white' }}>
                        {s}
                    </button>
                ))}
            </div>
            <div style={{ marginTop: 10, display: 'flex', justifyContent: 'center' }}>
                <button onClick={() => onPlacementSelect(slot, current)} style={{ padding: '8px 12px', borderRadius: 10, background: '#1b2140', border: '1px solid #2b2f47' }}>Use This Placement</button>
            </div>
        </div>
    )
}

export default EmptyVenueChooser




