// Pointer-event tile dragging (one path for mouse and touch), ported from the proto's
// bindTiles/slotUnder/drop (:870-945). The drop target hit-test and the moving ghost are
// intentionally imperative (60fps pointermove), contained inside this hook; the drop
// OUTCOME goes through React state via placeTileAt.

import { useCallback, useRef } from 'react'

export interface TileDrag {
  ghostRef: React.RefObject<HTMLDivElement>
  onTilePointerDown: (id: string, nm: string, e: React.PointerEvent<HTMLElement>) => void
  onTilePointerMove: (e: React.PointerEvent<HTMLElement>) => void
  onTilePointerUp: (e: React.PointerEvent<HTMLElement>) => void
  onTilePointerCancel: (e: React.PointerEvent<HTMLElement>) => void
}

const slotEls = (): HTMLElement[] =>
  typeof document === 'undefined' ? [] : Array.from(document.querySelectorAll<HTMLElement>('[data-builder-slot]'))

function slotUnder(x: number, y: number): HTMLElement | null {
  let found: HTMLElement | null = null
  slotEls().forEach((el) => {
    const r = el.getBoundingClientRect()
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) found = el
  })
  return found
}

function clearOver(): void {
  slotEls().forEach((el) => el.removeAttribute('data-over'))
}

export function useTileDrag(placeTileAt: (i: number, id: string) => void): TileDrag {
  const ghostRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ id: string; el: HTMLElement } | null>(null)

  const moveGhost = (x: number, y: number) => {
    const g = ghostRef.current
    if (!g) return
    g.style.left = x + 12 + 'px'
    g.style.top = y + 12 + 'px'
  }

  const onTilePointerDown = useCallback((id: string, nm: string, e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== undefined && e.button !== 0) return
    const el = e.currentTarget as HTMLElement
    dragRef.current = { id, el }
    el.style.opacity = '0.4'
    const g = ghostRef.current
    if (g) {
      g.textContent = nm
      g.style.display = 'block'
    }
    moveGhost(e.clientX, e.clientY)
    el.setPointerCapture?.(e.pointerId)
    e.preventDefault()
  }, [])

  const onTilePointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!dragRef.current) return
    moveGhost(e.clientX, e.clientY)
    clearOver()
    const t = slotUnder(e.clientX, e.clientY)
    if (t) t.setAttribute('data-over', 'true')
  }, [])

  const endDrag = () => {
    const g = ghostRef.current
    if (g) g.style.display = 'none'
    if (dragRef.current) dragRef.current.el.style.opacity = ''
    clearOver()
    dragRef.current = null
  }

  const onTilePointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const drag = dragRef.current
      if (!drag) return
      const target = slotUnder(e.clientX, e.clientY)
      if (target) {
        const i = Number(target.getAttribute('data-builder-slot'))
        if (!Number.isNaN(i)) placeTileAt(i, drag.id)
      }
      endDrag()
    },
    [placeTileAt],
  )

  const onTilePointerCancel = useCallback(() => {
    endDrag()
  }, [])

  return { ghostRef, onTilePointerDown, onTilePointerMove, onTilePointerUp, onTilePointerCancel }
}
