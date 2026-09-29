// The layout reducers are pure and live in src/core/layout so a second client (the native
// iOS app, a daemon-owned layout) can share them; the cockpit imports them from here as before.
export * from '../../../../src/core/layout/index.js'
