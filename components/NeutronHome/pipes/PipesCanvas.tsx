import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as PIXI from 'pixi.js'
import { VenueSlotsMap, FlowByVenue } from '../types'

type Props = {
    bundleRef: React.MutableRefObject<HTMLDivElement | null>
    slots: VenueSlotsMap
    flowByVenue: FlowByVenue
    healthIntensity?: number
}

export const PipesCanvas: React.FC<Props> = ({ bundleRef, slots, flowByVenue, healthIntensity = 1 }) => {
    const containerRef = useRef<HTMLDivElement | null>(null)
    const appRef = useRef<PIXI.Application | null>(null)
    const graphicsByVenue = useRef<Record<string, PIXI.Graphics>>({})
    const [layoutVersion, setLayoutVersion] = useState(0)

    // Setup Pixi
    useLayoutEffect(() => {
        const el = containerRef.current
        if (!el) return
        const app = new PIXI.Application({ resizeTo: el, antialias: true, backgroundAlpha: 0 })
        el.appendChild(app.view as any)
        appRef.current = app
        return () => {
            app.destroy(true, { children: true, texture: true, baseTexture: true })
            appRef.current = null
        }
    }, [])

    // Compute endpoints
    const endpoints = useMemo(() => {
        const list: { id: string; from: { x: number; y: number }; to: { x: number; y: number } }[] = []
        const bundle = bundleRef.current?.getBoundingClientRect()
        const host = containerRef.current?.getBoundingClientRect()
        if (!bundle || !host) return list
        const from = { x: bundle.left - host.left + bundle.width / 2, y: bundle.bottom - host.top }
            ; ([1, 3, 5] as const).forEach(i => {
                const slotEl = document.querySelector(`[data-venue-slot="${i}"]`) as HTMLElement | null
                const slot = slots[i]
                if (!slot || slot.type !== 'live' || !slotEl) return
                const r = slotEl.getBoundingClientRect()
                const to = { x: r.left - host.left + r.width / 2, y: r.top - host.top }
                list.push({ id: slot.venue.id, from, to })
            })
        return list
    }, [slots, layoutVersion])

    // Recompute endpoints when layout changes (resize/scroll)
    useEffect(() => {
        let raf = 0
        const schedule = () => {
            if (raf) return
            raf = requestAnimationFrame(() => { setLayoutVersion(v => v + 1); raf = 0 })
        }
        const onResize = () => schedule()
        const onScroll = () => schedule()
        window.addEventListener('resize', onResize)
        window.addEventListener('scroll', onScroll, { passive: true })
        const RO = (window as any).ResizeObserver
        const ro = RO ? new RO(() => schedule()) : undefined
        if (ro && containerRef.current) ro.observe(containerRef.current as Element)
        return () => {
            window.removeEventListener('resize', onResize)
            window.removeEventListener('scroll', onScroll)
            try { ro && containerRef.current && ro.unobserve(containerRef.current) } catch { }
            if (raf) cancelAnimationFrame(raf)
        }
    }, [])

    // Draw pipes
    useEffect(() => {
        const app = appRef.current
        if (!app) return
        const layer = new PIXI.Container()
        app.stage.removeChildren()
        app.stage.addChild(layer)

        endpoints.forEach(({ id, from, to }) => {
            const g = new PIXI.Graphics()
            g.lineStyle({ width: 6, color: 0x3a3f66, alpha: 0.8 })
            const cp1 = { x: from.x, y: from.y + 60 }
            const cp2 = { x: to.x, y: to.y - 60 }
            g.moveTo(from.x, from.y)
            g.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, to.x, to.y)
            layer.addChild(g)
            graphicsByVenue.current[id] = g
        })

        return () => {
            graphicsByVenue.current = {}
            layer.destroy({ children: true })
        }
    }, [endpoints])

    // Animate stroke dashoffset like effect with lineTexture
    useEffect(() => {
        const app = appRef.current
        if (!app) return
        let t = 0
        const tick = () => {
            t += app.ticker.deltaMS / 1000
            Object.entries(flowByVenue).forEach(([id, flow]) => {
                const g = graphicsByVenue.current[id]
                if (!g) return
                // When there is no deployment, keep pipes visible but empty (low alpha), no shimmer
                const speed = Math.max(0, Math.min(1, flow.speed))
                const hasFlow = speed > 0.0001
                const phase = hasFlow ? (t * (1 + speed * 4)) * flow.direction : 0
                const alphaBase = hasFlow ? (0.25 + speed * 0.55) : 0.15
                const alpha = alphaBase * (0.7 + 0.3 * healthIntensity)
                g.tint = 0xffffff
                g.alpha = alpha
                g.rotation = hasFlow ? 0.00001 * Math.sin(phase) : 0
            })
        }
        app.ticker?.add?.(tick)
        return () => {
            try {
                app.ticker?.remove?.(tick)
            } catch { }
        }
    }, [flowByVenue])

    const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (prefersReducedMotion) {
        return null // Fallback: handled by static UI; no canvas
    }
    return <div ref={containerRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
}

export default PipesCanvas


