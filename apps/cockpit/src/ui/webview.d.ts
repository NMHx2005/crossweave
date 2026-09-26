// Electron's <webview> tag (enabled with webviewTag in main.ts) is not an HTML element
// Preact knows; declared here so the browser pane typechecks.
import 'preact'

declare module 'preact' {
  namespace JSX {
    interface IntrinsicElements {
      webview: JSX.HTMLAttributes<HTMLElement> & { src?: string; partition?: string }
    }
  }
}
