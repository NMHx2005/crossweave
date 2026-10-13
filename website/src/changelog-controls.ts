export type ChangeCategory = 'new' | 'fixed' | 'removed' | 'upgrading' | 'known-limits'

export interface ReleaseEntry {
  tag: string
  categories: ChangeCategory[]
  searchText: string
  href: string
}

export interface ReleaseFilters {
  query: string
  version: string
  category: ChangeCategory | 'all'
}

function normalize(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

const HEADING_CATEGORIES: ReadonlyArray<[ChangeCategory, readonly string[]]> = [
  ['new', ['new', 'moi']],
  ['fixed', ['fixed', 'da sua']],
  ['removed', ['removed', 'da loai bo']],
  ['upgrading', ['upgrading', 'nang cap']],
  ['known-limits', ['known limits', 'gioi han da biet']],
]

export function categoryForHeading(heading: string): ChangeCategory | null {
  const normalized = normalize(heading)
  for (const [category, prefixes] of HEADING_CATEGORIES) {
    if (prefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `))) return category
  }
  return null
}

export function filterReleases(entries: readonly ReleaseEntry[], filters: ReleaseFilters): ReleaseEntry[] {
  const terms = normalize(filters.query).split(/\s+/).filter(Boolean)
  return entries.filter((entry) => {
    if (filters.version !== 'all' && filters.version !== entry.tag) return false
    if (filters.category !== 'all' && !entry.categories.includes(filters.category)) return false
    const haystack = normalize(`${entry.tag} ${entry.searchText}`)
    return terms.every((term) => haystack.includes(term))
  })
}

export function paginateReleases<T>(entries: readonly T[], requestedPage: number, pageSize = 3): { entries: T[]; page: number; pageCount: number; total: number } {
  const size = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 3
  const pageCount = Math.max(1, Math.ceil(entries.length / size))
  const page = Math.max(1, Math.min(pageCount, Math.floor(Number.isFinite(requestedPage) ? requestedPage : 1)))
  return { entries: entries.slice((page - 1) * size, page * size), page, pageCount, total: entries.length }
}
