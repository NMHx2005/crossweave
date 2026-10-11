import type { Lang } from '../site'

export interface Feature {
  id: string
  title: string
  text: string
  /** What limits the claim, in the same sentence-level honesty as the limitations files. */
  qualifier: string
  /** A repository path of the limitations file that backs the claim. */
  source: string
  source2?: string
  linkLabel: string
  /** The release that first shipped it, e.g. `v0.6.0`: a feature newer than the latest published release is badged. */
  since: string
  nextBadge(tag: string): string
  /** Where the feature sits on the home page, and its one sentence (the `text` and `qualifier` live behind the card's Limits). */
  group: 'run' | 'watch' | 'land' | 'review'
  summary: string
  /** Two or three words, for the announcement pill. */
  label: string
}

export interface Step {
  title: string
  command: string
  text: string
  imageAlt: string
}

export interface Content {
  readonly lang: Lang
  readonly htmlLang: string
  readonly siteName: string
  readonly nav: {
    skip: string
    download: string
    docs: string
    changelog: string
    github: string
    switchTo: string
    switchLabel: string
    mainLabel: string
    footerLabel: string
  }
  readonly home: {
    title: string
    description: string
    hero: {
      headline: string
      subtitle: string
      downloadCta: string
      installCta: string
      githubCta: string
      installNote: string
      shotAlt: string
      versionLine(version: string): string
      installLabel: string
      copyLabel: string
      copiedLabel: string
      copyFailedLabel: string
      appCta: string
      metaRelease(tag: string, date: string): string
      whatsNew: string
      videoAlt: string
      videoNote: string
      videoPauseLabel: string
      videoPlayLabel: string
      videoTranscript: { title: string; steps: string[] }
    }
    pill(tag: string, labels: string[]): string
    how: { title: string; intro: string; diagramAlt: string; steps: Step[] }
    groups: {
      title: string
      intro: string
      names: Record<'run' | 'watch' | 'land' | 'review', string>
      limits: string
      fullLimits: string
      coming(tag: string): string
      comingIntro: string
    }
    fit: { title: string; forTitle: string; forItems: string[]; notTitle: string; notItems: string[] }
    releases: { title: string; developing(tag: string): string; all: string }
    features: { title: string; intro: string; items: Feature[] }
    agents: { title: string; text: string; names: string[]; note: string }
    compare: { title: string; caption: string; headings: [string, string, string]; rows: Array<[string, string, string]>; foot: string }
    faq: { title: string; items: Array<{ q: string; a: string }> }
    cta: { title: string; text: string; button: string }
  }
  readonly download: {
    title: string
    description: string
    headline: string
    intro: string
    cockpit: { title: string; text: string; dmg: string; zip: string }
    cli: { title: string; text: string; installLine: string; manual: string; requires: string }
    notNotarized: { title: string; text: string; commandNote: string; installerNote: string }
    notarized: { title: string; text: string }
    checksums: string
    older: string
  }
  readonly footer: {
    tagline: string
    groups: { product: string; project: string }
    builtBy: string
    security: string
    contributing: string
    license: string
    issues: string
    version(v: string): string
  }
  /** Shown beside the links from a translated page to the English-only docs and changelog. */
  readonly docsNotice: string
  readonly notFound: { title: string; text: string; home: string }
}
