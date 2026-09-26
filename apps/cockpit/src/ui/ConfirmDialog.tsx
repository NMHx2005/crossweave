import { useEffect, useRef } from 'preact/hooks'

export type ConfirmRequest = {
  title: string
  body?: string
  confirmLabel: string
  /** A destructive action: the confirm button is red, and Enter does not choose it. */
  danger?: boolean
}

type ConfirmDialogProps = ConfirmRequest & {
  onConfirm: () => void
  onCancel: () => void
}

/**
 * The cockpit's own confirmation, replacing `window.confirm`: a native box broke the
 * app's look, ignored its theme, and blocked every IPC event while open.
 */
export function ConfirmDialog({ title, body, confirmLabel, danger = false, onConfirm, onCancel }: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    // A destructive choice is never the one a stray Enter makes.
    ;(danger ? cancelRef : confirmRef).current?.focus()
  }, [danger])

  return (
    <div class="cockpit-picker__backdrop" onClick={onCancel}>
      <div
        class="cockpit-picker cockpit-confirm"
        role="alertdialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
      >
        <h2 class="cockpit-picker__title">{title}</h2>
        {body ? <p class="cockpit-confirm__body">{body}</p> : null}
        <div class="cockpit-picker__actions">
          <button ref={cancelRef} type="button" onClick={onCancel}>Cancel</button>
          <button
            ref={confirmRef}
            type="button"
            class={danger ? 'is-danger' : 'is-primary'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
