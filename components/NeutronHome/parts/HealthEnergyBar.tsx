import React from 'react'

export const HealthEnergyBar = ({ percent }: { percent: number; color: string }) => {
    const clamped = Math.max(0, Math.min(100, percent || 0))

    const hexToRgb = (hex: string) => {
        const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
        return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 0, g: 0, b: 0 }
    }
    const rgbToHex = ({ r, g, b }: { r: number; g: number; b: number }) => {
        const toHex = (v: number) => v.toString(16).padStart(2, '0')
        return `#${toHex(Math.round(r))}${toHex(Math.round(g))}${toHex(Math.round(b))}`
    }
    const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.max(0, Math.min(1, t))
    const lerpColor = (hexA: string, hexB: string, t: number) => {
        const A = hexToRgb(hexA); const B = hexToRgb(hexB)
        return rgbToHex({ r: lerp(A.r, B.r, t), g: lerp(A.g, B.g, t), b: lerp(A.b, B.b, t) })
    }

    const green = '#52c41a'
    const yellow = '#faad14'
    const red = '#ff4d4f'
    const fillColor = clamped >= 60
        ? lerpColor(yellow, green, (clamped - 60) / 40)
        : lerpColor(red, yellow, clamped / 60)

    // 50% wider battery
    const bodyW = 54 // was 36 (previous), originally 28
    const bodyH = 140
    const nubW = 27 // was 18
    const nubH = 6

    return (
        <div aria-label="Energy" role="img"
            title={`Health ${clamped}%`}
            style={{ width: 72, height: 170, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ position: 'relative', width: bodyW, height: bodyH, borderRadius: 6, background: '#0b0d16', border: '1px solid #2b2f47' }}>
                <div style={{ position: 'absolute', top: -8, left: '50%', transform: 'translateX(-50%)', width: nubW, height: nubH, borderRadius: 2, background: '#2b2f47' }} />
                <div style={{ position: 'absolute', bottom: 4, left: 4, right: 4, top: 12, borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: `${clamped}%`, background: fillColor, boxShadow: `0 0 10px ${fillColor}55 inset` }} />
                </div>
            </div>
        </div>
    )
}



