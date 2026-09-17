import { render } from 'preact'
import { App } from './ui/App'
import { applyTokens } from './ui/tokens'
import './ui/app.css'

// Before render, or the first frame paints with no custom properties at all.
applyTokens()

const root = document.getElementById('app')
if (!root) {
  throw new Error('Missing #app mount point')
}

render(<App />, root)
