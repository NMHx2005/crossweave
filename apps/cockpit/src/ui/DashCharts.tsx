/** @jsxImportSource preact */
import { useState } from 'preact/hooks'
import { formatBytes, type DayPoint, type DiskBar } from '../lib/dashboard'

/**
 * The dashboard's two charts, in plain HTML/CSS so they take the theme's tokens and need no library. Both follow the same rules:
 * one axis and one hue (the accent), thin marks with a rounded data end anchored to the baseline, the value in text ink at the mark
 * (never the series colour), a tooltip on hover and focus, and a table of the very same numbers one click away — colour is never
 * the only carrier of a value.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "Sep 30" from `2026-09-30`; anything else is shown as it came. */
export function shortDay(day: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day)
  const month = m ? MONTHS[Number(m[1]) - 1] : undefined
  return m && month ? `${month} ${Number(m[2])}` : day
}

function ViewToggle({ table, onChange, what }: { table: boolean; onChange: (next: boolean) => void; what: string }) {
  return (
    <div class="cockpit-segmented cockpit-chart__toggle" role="radiogroup" aria-label={`${what}: view`}>
      <button type="button" role="radio" aria-checked={!table} class={`cockpit-segmented__option${!table ? ' is-on' : ''}`} onClick={() => onChange(false)}>Chart</button>
      <button type="button" role="radio" aria-checked={table} class={`cockpit-segmented__option${table ? ' is-on' : ''}`} onClick={() => onChange(true)}>Table</button>
    </div>
  )
}

/** Disk by project: horizontal bars, biggest first, the size at the end of each. */
export function DiskBars({ bars }: { bars: DiskBar[] }) {
  const [table, setTable] = useState(false)
  if (bars.length === 0) return <p class="cockpit-muted cockpit-chart__empty">Nothing measured yet — worktrees are sized in the background.</p>
  const max = Math.max(...bars.map((b) => b.bytes), 1)
  return (
    <figure class="cockpit-chart" aria-label="Disk held by each project's worktrees">
      <div class="cockpit-chart__head">
        <figcaption>Disk held by worktrees, per project</figcaption>
        <ViewToggle table={table} onChange={setTable} what="Disk by project" />
      </div>
      {table ? (
        <table class="cockpit-dtable">
          <thead><tr><th>Project</th><th class="is-num">Disk</th></tr></thead>
          <tbody>{bars.map((b) => <tr key={b.root}><td>{b.label}</td><td class="is-num">{b.approx ? '≥ ' : ''}{formatBytes(b.bytes)}</td></tr>)}</tbody>
        </table>
      ) : (
        <ul class="cockpit-hbars">
          {bars.map((b) => (
            <li key={b.root} class="cockpit-hbar" tabindex={0} data-tip={`${b.label}: ${b.approx ? 'at least ' : ''}${formatBytes(b.bytes)}`}
              aria-label={`${b.label}: ${b.approx ? 'at least ' : ''}${formatBytes(b.bytes)}`}>
              <span class="cockpit-hbar__name" title={b.root}>{b.label}</span>
              <span class="cockpit-hbar__track"><span class="cockpit-hbar__fill" style={{ width: `${Math.max(2, Math.round((b.bytes / max) * 100))}%` }} /></span>
              <span class="cockpit-hbar__value">{b.approx ? '≥ ' : ''}{formatBytes(b.bytes)}</span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  )
}

/** Sessions started per day over the last two weeks: columns, oldest to newest, the count above each. */
export function DayBars({ series }: { series: DayPoint[] }) {
  const [table, setTable] = useState(false)
  const started = series.reduce((n, p) => n + p.started, 0)
  const landed = series.reduce((n, p) => n + p.landed, 0)
  const max = Math.max(...series.map((p) => p.started), 1)
  return (
    <figure class="cockpit-chart" aria-label="Sessions started per day, last 14 days">
      <div class="cockpit-chart__head">
        <figcaption>Sessions started per day · {started} in 14 days, {landed} landed</figcaption>
        <ViewToggle table={table} onChange={setTable} what="Sessions per day" />
      </div>
      {table ? (
        <table class="cockpit-dtable">
          <thead><tr><th>Day (UTC)</th><th class="is-num">Started</th><th class="is-num">Landed</th></tr></thead>
          <tbody>{series.map((p) => <tr key={p.day}><td>{shortDay(p.day)}</td><td class="is-num">{p.started}</td><td class="is-num">{p.landed}</td></tr>)}</tbody>
        </table>
      ) : (
        <ol class="cockpit-vbars" aria-label="Started per day">
          {series.map((p, i) => (
            <li key={p.day} class="cockpit-vbar" tabindex={0} data-tip={`${shortDay(p.day)}: ${p.started} started, ${p.landed} landed`}
              aria-label={`${shortDay(p.day)}: ${p.started} started, ${p.landed} landed`}>
              <span class="cockpit-vbar__count">{p.started > 0 ? p.started : ''}</span>
              <span class="cockpit-vbar__col"><span class="cockpit-vbar__fill" style={{ height: p.started === 0 ? '0' : `${Math.max(6, Math.round((p.started / max) * 100))}%` }} /></span>
              <span class="cockpit-vbar__day">{i === 0 || i === series.length - 1 || i === Math.floor(series.length / 2) ? shortDay(p.day) : ''}</span>
            </li>
          ))}
        </ol>
      )}
    </figure>
  )
}
