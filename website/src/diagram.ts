import { escapeHtml } from './site'
import type { DiagramDetails } from './content/types'
import { html, type Html } from './types'

/**
 * One shared main worktree fans out into three session worktrees; trial evidence makes one candidate ready to land and keeps two blocked.
 * The complete SVG remains meaningful without animation. Escaped data text feeds the live explainer; native titles keep hover useful without JavaScript.
 */
export function diagramSvg(label: string, details: DiagramDetails): Html {
  const target = (part: string, detail: string): string => {
    const safe = escapeHtml(detail)
    return `role="button" tabindex="0" data-diagram-part="${part}" data-diagram-detail="${safe}" aria-label="${safe}"><title>${safe}</title>`
  }
  const session = (name: 'api' | 'web' | 'docs', hue: string, y: number): string => `
<g class="dg-session dg-session--${name} ${hue}" data-layer="session" ${target(`session-${name}`, details.sessions[name])}>
  <rect class="dg-session-card" x="250" y="${y}" width="238" height="68" rx="8" />
  <path class="dg-session-rule ${hue}" d="M250 ${y + 10} v48" />
  <text class="dg-kicker" x="270" y="${y + 27}">session</text>
  <text class="dg-session-name" x="270" y="${y + 50}">${name}</text>
</g>`

  const result = (kind: 'ready' | 'blocked', cls: string, part: string, y: number): string => `
<g class="dg-result ${cls}" data-result="${kind}" ${target(part, details[kind])}>
  <circle class="dg-result-mark" cx="782" cy="${y + 17}" r="5" />
  <text class="dg-result-label" x="797" y="${y + 21}">${kind === 'ready' ? 'ready' : 'blocked'}</text>
</g>`

  return html(`<svg class="diagram" viewBox="0 0 900 360" role="group" aria-label="${escapeHtml(label)}" xmlns="http://www.w3.org/2000/svg">
<g class="dg-connections">
<g class="dg-routes" ${target('routes', details.routes)}>
  <path class="dg-route-base" d="M182 158 C218 158 218 65 250 65 M182 180 H250 M182 202 C218 202 218 295 250 295" />
  <path class="dg-line dg-a dg-flow" d="M182 158 C218 158 218 65 250 65" />
  <path class="dg-line dg-b dg-flow" d="M182 180 H250" />
  <path class="dg-line dg-c dg-flow" d="M182 202 C218 202 218 295 250 295" />
  <path class="dg-route-base" d="M488 65 C546 65 540 157 590 157 M488 180 H590 M488 295 C546 295 540 203 590 203 M740 157 C756 157 752 89 770 89 M740 180 H770 M740 203 C756 203 752 249 770 249" />
  <path class="dg-try dg-flow" d="M488 65 C546 65 540 157 590 157 M488 180 H590 M488 295 C546 295 540 203 590 203 M740 157 C756 157 752 89 770 89 M740 180 H770 M740 203 C756 203 752 249 770 249" />
</g>
  <g class="dg-land-flow" data-layer="land" ${target('land', details.land)}>
    <path class="dg-route-base dg-route-base--land" d="M872 89 C884 22 175 20 102 126" />
    <path class="dg-land dg-flow" d="M872 89 C884 22 175 20 102 126" />
    <path class="dg-arrow" d="M95 121 L102 126 L96 133" />
    <text class="dg-label dg-land-label" x="802" y="53">land</text>
  </g>
</g>
<g class="dg-repository" data-layer="repository" ${target('repository', details.repository)}>
  <rect class="dg-repository-card" x="28" y="126" width="154" height="104" rx="8" />
  <text class="dg-kicker" x="48" y="151">repository</text>
  <text class="dg-repo-name" x="48" y="198">main</text>
  <text class="dg-label dg-land-text" x="48" y="217">land returns here</text>
</g>
${session('api', 'dg-a', 30)}
${session('web', 'dg-b', 145)}
${session('docs', 'dg-c', 260)}
<g class="dg-trial" data-layer="trial-merge" ${target('trial-merge', details.trialMerge)}>
  <rect class="dg-trial-card" x="590" y="130" width="150" height="100" rx="8" />
  <path class="dg-trial-glyph" d="M611 166 h34 m-8-8 8 8-8 8" />
  <text class="dg-kicker" x="611" y="151">evidence</text>
  <text class="dg-trial-title" x="611" y="198">trial merge</text>
  <text class="dg-label" x="611" y="216">check before land</text>
</g>
${result('ready', 'dg-ready', 'ready', 72)}
${result('blocked', 'dg-blocked dg-blocked--web', 'blocked-web', 163)}
${result('blocked', 'dg-blocked dg-blocked--docs', 'blocked-docs', 232)}
</svg>`)
}
