// Bun resolves `import x from './page.htm' with { type: 'text' }` to the file's
// contents, embedded in the compiled binary. `.htm`, not `.html`: bun-types already
// declares `*.html` as an HTMLBundle (Bun.serve's HTML imports), which a text import
// is not.
declare module '*.htm' {
  const text: string;
  export default text;
}
