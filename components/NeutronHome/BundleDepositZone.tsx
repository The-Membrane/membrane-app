import React, { useState, forwardRef } from 'react'
import useAssets from '@/hooks/useAssets'

type Props = {
    onAmountChange?: (amountCdt: number) => void
}

const presets = [10, 25, 50, 100]

const BUNDLE_CIRCLE_STYLE: React.CSSProperties = {
    width: 220,
    height: 220,
    borderRadius: '50%',
    background: 'radial-gradient(120px 120px at 50% 40%, #0f1628, #0b111c)',
    border: '1px solid #2b2f47',
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
}

const DRAG_PILL_STYLE: React.CSSProperties = {
    position: 'absolute',
    bottom: 12,
    left: '50%',
    transform: 'translateX(-50%)',
    padding: '6px 10px',
    borderRadius: 999,
    background: '#1b2140',
    border: '1px solid #2b2f47',
    cursor: 'grab',
    userSelect: 'none',
}

export const BundleDepositZone = forwardRef<HTMLDivElement, Props>(function BundleDepositZone({ onAmountChange }, ref) {
    const assets = (useAssets() as any[]) || []
    const [amount, setAmount] = useState<number>(10)
    const [selected, setSelected] = useState<string[]>([])

    return (
        <div ref={ref} style={{ width: 280, display: 'flex', justifyContent: 'center' }}>
            <div style={BUNDLE_CIRCLE_STYLE}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Bundle</div>

                {/* Asset chips */}
                {/* js-set-map-lookups FP: rendered chips are capped to 8 via slice(0, 8), and
                    `selected` can only ever contain a subset of those 8 ids — both arrays are
                    well under the ~10-item threshold where a Set pays off. */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                    {assets.slice(0, 8).map((a: any) => {
                        const id = a?.symbol || a?.base
                        const active = selected.includes(id)
                        return (
                            <button key={id} type="button" onClick={() => setSelected((s) => (s.includes(id) ? s.filter(x => x !== id) : [...s, id]))}
                                style={{ padding: '4px 8px', borderRadius: 12, border: `1px solid ${active ? '#2dc5ff' : '#2b2f47'}`, background: active ? '#112235' : '#0f1424', fontSize: 12 }}>
                                {id}
                            </button>
                        )
                    })}
                </div>

                {/* Amount input */}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, width: 160 }}>
                    <input
                        type="number"
                        aria-label="Bundle amount in CDT"
                        min={0}
                        value={amount}
                        onChange={(e) => {
                            const v = Number(e.target.value || 0)
                            setAmount(v)
                            onAmountChange?.(v)
                        }}
                        style={{ flex: 1, background: '#0f1424', color: 'white', border: '1px solid #2b2f47', borderRadius: 8, padding: '8px 10px' }}
                    />
                    <div style={{ fontSize: 12, opacity: 0.8 }}>CDT</div>
                </div>

                {/* Presets */}
                <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                    {presets.map(p => (
                        <button key={p} type="button" onClick={() => { setAmount(p); onAmountChange?.(p) }} style={{ padding: '6px 10px', borderRadius: 8, background: '#101731', border: '1px solid #2b2f47', fontSize: 12 }}>{p}</button>
                    ))}
                </div>

                {/* Draggable pill uses current amount */}
                <div
                    draggable
                    onDragStart={(e) => { e.dataTransfer.setData('text/plain', String(amount)); e.dataTransfer.effectAllowed = 'copy' }}
                    style={DRAG_PILL_STYLE}
                >
                    Drag {amount} CDT →
                </div>
            </div>
        </div>
    )
})

export default BundleDepositZone


