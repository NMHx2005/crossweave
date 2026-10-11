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
    }
    features: { title: string; intro: string; items: Feature[] }
    agents: { title: string; text: string; names: string[]; note: string }
    not: { title: string; intro: string; items: Array<{ title: string; text: string }> }
    compare: { title: string; caption: string; headings: [string, string, string]; rows: Array<[string, string, string]>; foot: string }
    why: { title: string; text: string }
    faq: { title: string; items: Array<{ q: string; a: string }> }
    cta: { title: string; text: string }
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
    license: string
    issues: string
    version(v: string): string
  }
  /** Shown beside the links from a translated page to the English-only docs and changelog. */
  readonly docsNotice: string
  readonly notFound: { title: string; text: string; home: string }
}
