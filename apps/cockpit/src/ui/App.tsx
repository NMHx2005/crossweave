export function App() {
  return (
    <div class="cockpit-shell">
      <aside class="cockpit-rail" aria-label="Agent rail">
        <header class="cockpit-rail__header">
          <h1>Cockpit</h1>
          <p class="cockpit-muted">Agent rail</p>
        </header>
        <p class="cockpit-placeholder">Sessions will appear here.</p>
      </aside>
      <main class="cockpit-stage" aria-label="Stage">
        <header class="cockpit-stage__header">
          <h2>Stage</h2>
          <p class="cockpit-muted">xterm panes will mount here.</p>
        </header>
        <p class="cockpit-placeholder">Daemon bridge is live. xterm panes land in Task 4.</p>
      </main>
    </div>
  )
}
