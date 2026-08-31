import { useCallback, useEffect, useRef } from 'react'

/**
 * Wires a <canvas> to a painter with the proto's exact DPR/resize dance:
 * size the backing store to devicePixelRatio, apply the transform, hand the
 * painter a context in logical (CSS-pixel) space. Repaints whenever `deps`
 * change and on window resize.
 */
export function useCanvasPainter(
  paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  deps: React.DependencyList,
) {
  const ref = useRef<HTMLCanvasElement | null>(null)

  const render = useCallback(() => {
    const cv = ref.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const W = cv.clientWidth || cv.parentElement?.clientWidth || 0
    const H = cv.clientHeight || 0
    if (!W || !H) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    cv.width = Math.round(W * dpr)
    cv.height = Math.round(H * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    paint(ctx, W, H)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(() => {
    render()
    window.addEventListener('resize', render)
    return () => window.removeEventListener('resize', render)
  }, [render])

  return ref
}
