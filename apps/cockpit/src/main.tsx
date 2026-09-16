import { render } from 'preact'
import { App } from './ui/App'
import './ui/app.css'

const root = document.getElementById('app')
if (!root) {
  throw new Error('Missing #app mount point')
}

render(<App />, root)
