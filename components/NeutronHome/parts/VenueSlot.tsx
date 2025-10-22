import React from 'react'
import { VenueSlot as Slot } from '../types'

export const VenueSlot: React.FC<{ slot: Slot; onDeploy: (id: string) => void; onRetrieve: (id: string) => void; healthPercent?: number }> = ({ slot, onDeploy, onRetrieve, healthPercent }) => {
    if (slot.type === 'placeholder') {
        return (
            <div data-venue-slot={slot.slot} style={{ height: 140, borderRadius: 12, border: '1px dashed #2b2f47', background: '#0d0f1a', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.6 }}>
                Coming soon
            </div>
        )
    }
    const disabled = typeof slot.venue.minHealth === 'number' && typeof healthPercent === 'number' && healthPercent < (slot.venue.minHealth || 0)
    const reason = disabled ? `Requires health ≥ ${slot.venue.minHealth}%` : ''
    return (
        <div data-venue-slot={slot.slot} style={{ height: 140, borderRadius: 12, border: '1px solid #2b2f47', background: '#0d0f1a', padding: 12, position: 'relative' }}>
            <div style={{ fontWeight: 700 }}>{slot.venue.name || slot.venue.id}</div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>APR: {slot.venue.apr ? `${slot.venue.apr}%` : '—'}</div>
            {/* Drop target */}
            <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                    const amount = Number(e.dataTransfer.getData('text/plain') || '0')
                    if (amount > 0 && !disabled) onDeploy(slot.venue.id)
                }}
                style={{ position: 'absolute', inset: 0, borderRadius: 12, pointerEvents: 'auto' }}
            />
            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between' }}>
                <button onClick={() => onDeploy(slot.venue.id)} disabled={disabled} title={reason} style={{ padding: '6px 10px', borderRadius: 8, background: disabled ? '#1a1f33' : '#1b2140', opacity: disabled ? 0.6 : 1, border: '1px solid #2b2f47' }}>Deploy</button>
                <button onClick={() => onRetrieve(slot.venue.id)} style={{ padding: '6px 10px', borderRadius: 8, background: '#141a2f', border: '1px solid #2b2f47' }}>Retrieve</button>
            </div>
            {disabled && <div style={{ marginTop: 6, fontSize: 11, opacity: 0.75 }}>{reason}</div>}
        </div>
    )
}


