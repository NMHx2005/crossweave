import { describe, expect, test } from 'bun:test'
import { combineWarnings, landSensitiveWarning } from '../src/lib/rail'

describe('landSensitiveWarning', () => {
  test('nothing to say for no files, ordinary files, or only the kinds that get a badge but no question', () => {
    expect(landSensitiveWarning('alpha', [])).toBeUndefined()
    expect(landSensitiveWarning('alpha', ['src/a.ts', 'README.md'])).toBeUndefined()
    expect(landSensitiveWarning('alpha', ['package.json', 'bun.lock', 'db/migrate/1.rb'])).toBeUndefined()
  })

  test('a secret-like or automation file asks first, naming the session and only the files that made it ask', () => {
    const w = landSensitiveWarning('alpha', ['package.json', 'src/a.ts', '.github/workflows/ci.yml', '.env.production'])!
    expect(w.title).toBe('Land alpha with sensitive files?')
    expect(w.confirmLabel).toBe('Land anyway')
    expect(w.body).toContain('.env.production — secret')
    expect(w.body).toContain('.github/workflows/ci.yml — automation')
    expect(w.body).not.toContain('package.json')
    expect(w.body).toContain('by name only')
  })

  test('lists at most eight files and counts the rest', () => {
    const paths = Array.from({ length: 9 }, (_, i) => `ci/${i}/.gitlab-ci.yml`)
    const body = landSensitiveWarning('a', paths)!.body
    expect(body).toContain('ci/7/.gitlab-ci.yml')
    expect(body).not.toContain('ci/8/.gitlab-ci.yml')
    expect(body).toContain('and 1 more')
  })

  // A path is repository content: it must stay one plain line in the dialog.
  test('a newline, a tab or a bidi override in a path cannot reshape the dialog', () => {
    const body = landSensitiveWarning('a', ['evil\n— secret\t\u202eyx.env/.env.production'])!.body
    const lines = body.split('\n')
    expect(lines.length).toBe(2)
    expect(body).not.toMatch(/[\t\u202e]/)
  })
})

describe('combineWarnings', () => {
  const sens = { title: 'Land alpha with sensitive files?', body: 'files…', confirmLabel: 'Land anyway' }
  const tests = { title: 'Land alpha with failing tests?', body: 'tests…', confirmLabel: 'Land anyway' }

  test('both questions become one dialog with both bodies', () => {
    expect(combineWarnings('alpha', sens, tests)).toEqual({ title: 'Land alpha anyway?', body: 'files…\n\ntests…', confirmLabel: 'Land anyway' })
  })
  test('one question keeps its own words; none stays none', () => {
    expect(combineWarnings('alpha', sens, undefined)).toBe(sens)
    expect(combineWarnings('alpha', undefined, tests)).toBe(tests)
    expect(combineWarnings('alpha', undefined, undefined)).toBeUndefined()
  })
})
