import { createHash } from 'node:crypto';

/**
 * Strips `//` and `#` line comments plus `/* *\/` block comments, then
 * collapses all whitespace runs to a single space, before hashing. This is a
 * DELIBERATELY blunt normalizer — it does not parse strings, so a `//` or
 * `#` appearing inside a string literal is stripped as if it started a
 * comment. That is an accepted over-normalization (see the M3 design doc
 * §4): the failure mode is treating a change as whitespace/comment-only when
 * it technically wasn't, which suppresses a claim rather than fabricating a
 * false collision — the safer direction to be wrong in for a noise-control
 * mechanism.
 */
export function normalizeAndHash(source: string): string {
  const noBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const noLineComments = noBlockComments.replace(/(\/\/|#).*$/gm, '');
  const collapsed = noLineComments.replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(collapsed).digest('hex');
}
