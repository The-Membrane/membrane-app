import { useEffect, useState, type RefObject } from 'react'

/** Content-box size of an element, px; 0×0 until measured (SSR and first paint). */
export function useElementSize(ref: RefObject<HTMLElement | null>): {
  width: number
  height: number
} {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const r = el.getBoundingClientRect()
      setSize((s) =>
        s.width === Math.round(r.width) && s.height === Math.round(r.height)
          ? s
          : { width: Math.round(r.width), height: Math.round(r.height) },
      )
    }
    update()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}
