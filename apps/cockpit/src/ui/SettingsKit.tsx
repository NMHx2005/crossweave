/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact'
import { SETTINGS_SECTIONS } from '../lib/settings-sections'

/**
 * The settings page's pieces, after Cursor's: a group is a small heading over a rounded card, a card is a list of rows separated by
 * hairlines, and a row is the setting's name and description on the left with its control on the right. A row's words come from the
 * registry by `id` — the same words the search index and the deep links use — so the page, the search and the links cannot drift.
 */

const ROWS = new Map(SETTINGS_SECTIONS.flatMap((s) => s.rows.map((r) => [r.id, r] as const)))

export function SettingsGroup({ title, note, dataSetting, children }: { title?: string; note?: ComponentChildren; dataSetting?: string; children: ComponentChildren }) {
  return (
    <section class="cockpit-sgroup" data-setting={dataSetting}>
      {title !== undefined ? <h3 class="cockpit-sgroup__title">{title}</h3> : null}
      <div class="cockpit-scard">{children}</div>
      {note !== undefined ? <p class="cockpit-sgroup__note">{note}</p> : null}
    </section>
  )
}

export type SettingRowProps = {
  /** The registry id: also the element's `data-setting`, which deep links and search hits scroll to. */
  id: string
  /** Overrides the registry's words, for a sub-row the registry does not list on its own. */
  label?: string
  description?: ComponentChildren
  /** The control goes under the words instead of beside them (a command line, a list, a textarea). */
  stacked?: boolean
  children?: ComponentChildren
}

export function SettingRow({ id, label, description, stacked = false, children }: SettingRowProps) {
  const known = ROWS.get(id)
  const title = label ?? known?.label ?? id
  const words = description ?? known?.description
  return (
    <div class={`cockpit-srow${stacked ? ' is-stacked' : ''}`} data-setting={id}>
      <div class="cockpit-srow__text">
        <div class="cockpit-srow__label">{title}</div>
        {words !== undefined && words !== '' ? <div class="cockpit-srow__desc">{words}</div> : null}
      </div>
      {children !== undefined ? <div class="cockpit-srow__control">{children}</div> : null}
    </div>
  )
}

/** A toggle. A real `role="switch"` button: keyboard (Space/Enter), screen readers and a visible focus ring come with it. */
export function Switch({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      class="cockpit-switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span class="cockpit-switch__thumb" aria-hidden="true" />
    </button>
  )
}

/** A row of exclusive choices as compact buttons (theme, text size, cursor). */
export function Segmented<T extends string>({ value, options, onChange, label, disabledIds = [] }: {
  value: T
  options: ReadonlyArray<{ id: T; label: string; title?: string }>
  onChange: (next: T) => void
  label: string
  disabledIds?: readonly T[]
}) {
  return (
    <div class="cockpit-segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          disabled={disabledIds.includes(o.id)}
          title={o.title}
          class={`cockpit-segmented__option${value === o.id ? ' is-on' : ''}`}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** News at the top of a page, dismissible; what was dismissed is the caller's to remember. */
export function Banner({ title, children, actionLabel, onAction, onDismiss }: {
  title: string
  children: ComponentChildren
  actionLabel?: string
  onAction?: () => void
  onDismiss: () => void
}) {
  return (
    <div class="cockpit-sbanner" role="region" aria-label={title}>
      <div class="cockpit-sbanner__text">
        <strong>{title}</strong>
        <span>{children}</span>
      </div>
      <div class="cockpit-sbanner__actions">
        <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-btn--ghost" onClick={onDismiss}>Dismiss</button>
        {actionLabel !== undefined && onAction !== undefined ? <button type="button" class="cockpit-btn cockpit-btn--sm" onClick={onAction}>{actionLabel}</button> : null}
      </div>
    </div>
  )
}
