/**
 * The Settings form's launcher helpers, pure so the rules are tested: environment as
 * `KEY=VALUE` lines, and an id for a new launcher from its label.
 */

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export type ParsedEnv = { ok: true; env: Record<string, string> } | { ok: false; error: string }

/** `KEY=VALUE` per line; blank lines and `# comments` are skipped. */
export function parseEnvLines(text: string): ParsedEnv {
  const env: Record<string, string> = {}
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    const key = eq === -1 ? line : line.slice(0, eq).trim()
    if (eq === -1 || !ENV_NAME.test(key)) return { ok: false, error: `Line ${i + 1}: write it as NAME=value` }
    env[key] = line.slice(eq + 1).trim()
  }
  return { ok: true, env }
}

export function formatEnvLines(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')
}

/** A new launcher's id from its label: lowercase, dashes, unique among `taken`. */
export function launcherIdFor(label: string, taken: readonly string[]): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'launcher'
  const safe = /^[a-z0-9]/.test(base) && base !== 'terminal' ? base : `x-${base}`
  if (!taken.includes(safe)) return safe
  for (let n = 2; ; n++) if (!taken.includes(`${safe}-${n}`)) return `${safe}-${n}`
}
