import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { embedParam } from './lib/countries'

// Embed mode (#97): decide BEFORE importing App, so the dynamic imports
// split the bundle and an iframe embed never downloads maplibre or the map
// data — just React, the strip and one snapshot fetch.
const embed = embedParam(window.location.search)
const root = createRoot(document.getElementById('root')!)

if (embed) {
  import('./Embed.tsx').then(({ default: Embed }) =>
    root.render(
      <StrictMode>
        <Embed countryId={embed} />
      </StrictMode>,
    ),
  )
} else {
  import('./App.tsx').then(({ default: App }) =>
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  )
}
