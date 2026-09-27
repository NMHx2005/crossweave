import { describe, expect, test } from 'bun:test'
import { appearanceVars } from '../src/lib/appearance'
import { COCKPIT_TOKENS } from '../src/ui/tokens'

describe('appearanceVars', () => {
  test('nothing chosen: exactly the tokens (so choosing the default again resets)', () => {
    expect(appearanceVars(undefined)).toEqual({
      '--cw-font-ui': COCKPIT_TOKENS['--cw-font-ui'],
      '--cw-font-mono': COCKPIT_TOKENS['--cw-font-mono'],
      '--cw-fs-micro': COCKPIT_TOKENS['--cw-fs-micro'],
      '--cw-fs-sm': COCKPIT_TOKENS['--cw-fs-sm'],
      '--cw-fs': COCKPIT_TOKENS['--cw-fs'],
      '--cw-fs-rail': COCKPIT_TOKENS['--cw-fs-rail'],
      '--cw-fs-project': COCKPIT_TOKENS['--cw-fs-project'],
    })
  })

  test('chosen families lead, the cockpit stacks follow', () => {
    const vars = appearanceVars({ uiFont: 'Inter', codeFont: 'JetBrains Mono' })
    expect(vars['--cw-font-ui']).toBe(`"Inter", ${COCKPIT_TOKENS['--cw-font-ui']}`)
    expect(vars['--cw-font-mono']).toBe(`"JetBrains Mono", ${COCKPIT_TOKENS['--cw-font-mono']}`)
  })

  test('small and large move every step of the type scale by a pixel', () => {
    expect(appearanceVars({ textSize: 'large' })['--cw-fs']).toBe('14px')
    expect(appearanceVars({ textSize: 'large' })['--cw-fs-project']).toBe('16px')
    expect(appearanceVars({ textSize: 'small' })['--cw-fs-micro']).toBe('10px')
    expect(appearanceVars({ textSize: 'default' })['--cw-fs']).toBe(COCKPIT_TOKENS['--cw-fs'])
  })
})
