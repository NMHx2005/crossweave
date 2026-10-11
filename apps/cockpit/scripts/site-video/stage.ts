/**
 * The in-page stage the demo clip is filmed on. It is injected into the running cockpit (over CDP) and turns the window into a
 * floating app on a flat backdrop, with a camera layer (zoom and pan), a mouse cursor with click ripples, and constant-size captions
 * and cards above it. Everything here is a plain function of numbers the recorder sets before each frame; nothing runs on its own.
 *
 * Geometry contract: the stage is the viewport (STAGE_W x STAGE_H CSS px). `#cw-camera` is `transform: translate(tx, ty) scale(z)` with
 * `transform-origin: 0 0`; it holds the window (`#cw-win`, WIN_W x WIN_H at WIN_X, WIN_Y), the cursor and the ripple. A point
 * (x, y) in stage coordinates is at (z * x + tx, z * y + ty) in the viewport, and that is where a real mouse event must be sent.
 */
export const STAGE_W = 1920
export const STAGE_H = 1080
export const WIN_W = 1360
export const WIN_H = 850
export const WIN_X = (STAGE_W - WIN_W) / 2
export const WIN_Y = (STAGE_H - WIN_H) / 2 + 6

export interface StageTokens {
  accent: string
  surface: string
  agents: string[]
}

/** The cockpit's own tokens, read in the page before the stage is built so the backdrop and the captions use the app's colours. */
export const READ_TOKENS = `(() => {
  const css = getComputedStyle(document.documentElement)
  const tok = (name, fallback) => css.getPropertyValue(name).trim() || fallback
  return {
    accent: tok('--cw-accent', '#61afef'),
    surface: tok('--cw-surface', '#16191d'),
    agents: [tok('--cw-agent-claude', '#d97757'), tok('--cw-agent-gemini', '#8ab4f8'), tok('--cw-agent-copilot', '#c49bff'), tok('--cw-ready', '#a5e075')],
  }
})()`

const STAGE_CSS = (t: StageTokens): string => `
html, body { margin: 0; overflow: hidden; background: #0e1013 !important; }
:root { --cw-rail-w: 340px; }
#cw-stage { position: fixed; inset: 0; overflow: hidden; background: radial-gradient(1200px 700px at 50% 38%, #1a1e25 0%, #0e1013 70%); z-index: 2147483000; font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', system-ui, sans-serif; }
#cw-threads { position: absolute; inset: 0; opacity: .5; }
#cw-camera { position: absolute; left: 0; top: 0; width: ${STAGE_W}px; height: ${STAGE_H}px; transform-origin: 0 0; }
#cw-win { position: absolute; left: ${WIN_X}px; top: ${WIN_Y}px; width: ${WIN_W}px; height: ${WIN_H}px; border-radius: 16px; overflow: hidden; contain: layout paint; background: ${t.surface};
  box-shadow: 0 0 0 1px rgba(255,255,255,.09), 0 50px 120px rgba(0,0,0,.65), 0 18px 40px rgba(0,0,0,.45); }
#cw-win > #app { position: absolute; inset: 0; width: ${WIN_W}px; height: ${WIN_H}px; min-height: 0 !important; }
#cw-lights { position: absolute; left: 18px; top: 16px; display: flex; gap: 8px; z-index: 5; pointer-events: none; }
#cw-lights i { width: 12px; height: 12px; border-radius: 50%; display: block; }
#cw-cursor { position: absolute; left: 0; top: 0; width: 26px; height: 26px; pointer-events: none; z-index: 50; filter: drop-shadow(0 3px 5px rgba(0,0,0,.55)); }
#cw-ripple { position: absolute; left: 0; top: 0; width: 60px; height: 60px; margin: -30px 0 0 -30px; border-radius: 50%; border: 3px solid ${t.accent}; pointer-events: none; z-index: 49; opacity: 0; }
#cw-overlay { position: absolute; inset: 0; pointer-events: none; }
.cw-caption { position: absolute; left: 50%; bottom: 74px; display: flex; align-items: center; gap: 18px; padding: 16px 30px 16px 18px; border-radius: 20px; color: #f2f4f7;
  background: rgba(18,20,24,.88); box-shadow: 0 0 0 1px rgba(255,255,255,.12), 0 18px 50px rgba(0,0,0,.5); font-size: 30px; font-weight: 560; letter-spacing: -.01em; white-space: nowrap; opacity: 0; transform: translate(-50%, 0); }
.cw-caption b { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 50%; background: ${t.accent}; color: #101216; font-size: 24px; font-weight: 700; flex: none; }
.cw-card { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; gap: 22px; text-align: center; color: #f2f4f7; opacity: 0; }
.cw-card img { width: 96px; height: 96px; }
.cw-card h1 { margin: 0; font-size: 92px; letter-spacing: -.03em; font-weight: 700; }
.cw-card p { margin: 0; font-size: 36px; color: #aab1bc; font-weight: 450; }
.cw-card .small { font-size: 26px; color: #8a919c; }
`

/** The JS that builds the stage in the page; the tokens, the geometry and the captions' and cards' markup are all fixed here, in TypeScript. */
export function installStage(t: StageTokens, overlayHtml: string, iconDataUrl: string): string {
  const css = JSON.stringify(STAGE_CSS(t))
  const lines: string[] = []
  for (let i = 0; i < 22; i++) {
    const x = -200 + i * 120
    lines.push(`<line x1="${x}" y1="-20" x2="${x + 520}" y2="1100" stroke="${t.agents[i % 4]}" stroke-opacity="${i % 3 === 0 ? 0.16 : 0.07}" stroke-width="1.5"/>`)
  }
  for (let i = 0; i < 9; i++) lines.push(`<line x1="-20" y1="${80 + i * 130}" x2="1940" y2="${120 + i * 130}" stroke="#ffffff" stroke-opacity="0.035" stroke-width="1"/>`)
  return `(() => {
  if (document.getElementById('cw-stage')) return 'already'
  const app = document.getElementById('app')
  if (!app) return 'no #app'
  const style = document.createElement('style'); style.textContent = ${css}; document.head.appendChild(style)
  const stage = document.createElement('div'); stage.id = 'cw-stage'
  stage.innerHTML = ${JSON.stringify(`<svg id="cw-threads" viewBox="0 0 ${STAGE_W} ${STAGE_H}" preserveAspectRatio="none">${lines.join('')}</svg>`)}
  const camera = document.createElement('div'); camera.id = 'cw-camera'
  const win = document.createElement('div'); win.id = 'cw-win'
  const lights = document.createElement('div'); lights.id = 'cw-lights'
  lights.innerHTML = '<i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i>'
  const cursor = document.createElement('div'); cursor.id = 'cw-cursor'
  cursor.innerHTML = '<svg viewBox="0 0 26 26" width="26" height="26"><path d="M3 2 L3 21 L8.2 16.4 L11.6 24 L15 22.6 L11.7 15.2 L18.6 15 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>'
  const ripple = document.createElement('div'); ripple.id = 'cw-ripple'
  const overlay = document.createElement('div'); overlay.id = 'cw-overlay'
  overlay.innerHTML = ${JSON.stringify(overlayHtml)}.replace(/__ICON__/g, ${JSON.stringify(iconDataUrl)})
  app.parentNode.insertBefore(stage, app)
  win.appendChild(app); win.appendChild(lights)
  camera.appendChild(win); camera.appendChild(ripple); camera.appendChild(cursor)
  stage.appendChild(camera); stage.appendChild(overlay)
  stage.insertBefore(stage.querySelector('#cw-threads'), camera)
  window.dispatchEvent(new Event('resize'))
  return 'installed'
})()`
}

/** One call per frame: sets the camera, the cursor, the ripple and the captions and cards for that instant. */
export interface FrameState {
  camera: { tx: number; ty: number; z: number }
  cursor: { x: number; y: number; visible: boolean }
  ripple: { x: number; y: number; progress: number } | null
  captions: Array<{ id: string; opacity: number; lift: number }>
  cards: Array<{ id: string; opacity: number }>
}

export const APPLY_FRAME = `((s) => {
  const camera = document.getElementById('cw-camera')
  camera.style.transform = 'translate(' + s.camera.tx + 'px,' + s.camera.ty + 'px) scale(' + s.camera.z + ')'
  const cursor = document.getElementById('cw-cursor')
  cursor.style.display = s.cursor.visible ? 'block' : 'none'
  cursor.style.transform = 'translate(' + s.cursor.x + 'px,' + s.cursor.y + 'px) scale(' + (1 / Math.max(1, s.camera.z * 0.8)) + ')'
  cursor.style.transformOrigin = '3px 2px'
  const ripple = document.getElementById('cw-ripple')
  if (s.ripple) {
    ripple.style.opacity = String(1 - s.ripple.progress)
    ripple.style.transform = 'translate(' + s.ripple.x + 'px,' + s.ripple.y + 'px) scale(' + (0.35 + s.ripple.progress * 1.2) + ')'
  } else ripple.style.opacity = '0'
  for (const c of s.captions) {
    const el = document.getElementById(c.id)
    if (el) { el.style.opacity = String(c.opacity); el.style.transform = 'translate(-50%,' + c.lift + 'px)' }
  }
  for (const c of s.cards) { const el = document.getElementById(c.id); if (el) el.style.opacity = String(c.opacity) }
  return true
})`
