import type { RefObject } from 'preact'
import { useEffect } from 'preact/hooks'

/**
 * Close a popup on Escape or on a press outside `ref`. The Layouts menu and the rail's
 * colour menu closed only on a click inside their own area (or on mouse-leave), so a
 * menu opened by mistake stayed open until the user found the one way out.
 */
export function useDismiss(open: boolean, close: () => void, ref?: RefObject<HTMLElement>): void {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    const onPress = (e: MouseEvent): void => {
      if (ref?.current && e.target instanceof Node && ref.current.contains(e.target)) return
      close()
    }
    window.addEventListener('keydown', onKey)
    // Capture, so a press that another handler stops still dismisses.
    window.addEventListener('mousedown', onPress, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onPress, true)
    }
  }, [open, close, ref])
}
