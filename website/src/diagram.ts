import { escapeHtml } from './site'
import { html, type Html } from './types'

/**
 * main, three session branches, a trial merge, a land: the idea of the product in one picture. Shapes carry classes only (no `style`
 * attribute, which the page's policy forbids); the colours are the cockpit's tokens, set in styles.css, so the picture follows the theme.
 */
export function diagramSvg(label: string): Html {
  const lane = (cls: string, y: number, name: string, verdict: 'ok' | 'conflict'): string => `
<path class="dg-line ${cls}" d="M80 40 C 110 40 110 ${y} 140 ${y} L 400 ${y}" />
<circle class="dg-dot ${cls}" cx="200" cy="${y}" r="4" /><circle class="dg-dot ${cls}" cx="300" cy="${y}" r="4" />
<text class="dg-label ${cls}" x="150" y="${y - 10}">${name}</text>
<path class="dg-try" d="M400 ${y} L 470 110" />
<text class="dg-verdict dg-${verdict}" x="380" y="${y - 10}">${verdict === 'ok' ? '✓' : '✗'}</text>`
  return html(`<svg class="diagram" viewBox="0 0 720 220" role="img" aria-label="${escapeHtml(label)}" xmlns="http://www.w3.org/2000/svg">
<path class="dg-main" d="M20 40 L 700 40" />
<circle class="dg-dot dg-main" cx="60" cy="40" r="4" /><circle class="dg-dot dg-main" cx="560" cy="40" r="4" /><circle class="dg-dot dg-main" cx="640" cy="40" r="4" />
<text class="dg-label dg-main" x="20" y="26">main</text>${lane('dg-a', 85, 'api', 'ok')}${lane('dg-b', 130, 'web', 'conflict')}${lane('dg-c', 175, 'docs', 'conflict')}
<path class="dg-diamond" d="M470 98 L 482 110 L 470 122 L 458 110 Z" />
<text class="dg-label dg-main" x="494" y="150">trial merge</text>
<path class="dg-land" d="M482 110 C 520 110 520 40 560 40" />
<text class="dg-label dg-ok" x="505" y="82">land</text>
</svg>`)
}
