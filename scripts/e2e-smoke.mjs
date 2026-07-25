/**
 * e2e smoke (#63): build → serve dist → load a country in headless Chrome →
 * assert the map actually renders. Catches the "blank map" class of failure
 * that unit tests can't see (broken style spec, source wiring, runtime
 * exceptions on boot).
 *
 *   npm run build && node scripts/e2e-smoke.mjs
 *
 * Uses playwright-core with a system Chrome/Chromium: CHROME_BIN, the
 * GitHub-runner Chrome, or the local sandbox build — no browser download.
 * The static server honours HTTP Range requests (PMTiles needs them; plain
 * `python -m http.server` famously doesn't).
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { chromium } from 'playwright-core'

const DIST = join(process.cwd(), 'dist')
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.pmtiles': 'application/octet-stream',
}

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/opt/pw-browsers/chromium',
  ].filter(Boolean)
  for (const c of candidates) if (existsSync(c)) return c
  throw new Error('no Chrome/Chromium found — set CHROME_BIN')
}

/** Minimal static server with Range support (for the PMTiles archive). */
function serve(root) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '')
    if (path === '' || path === '.') path = 'index.html'
    const file = join(root, path)
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404)
      res.end()
      return
    }
    const size = statSync(file).size
    const type = MIME[extname(file)] ?? 'application/octet-stream'
    const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/)
    if (range) {
      const start = parseInt(range[1], 10)
      const end = range[2] ? parseInt(range[2], 10) : size - 1
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
      })
      createReadStream(file, { start, end }).pipe(res)
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' })
      createReadStream(file).pipe(res)
    }
  })
  return new Promise((resolve) => server.listen(0, () => resolve(server)))
}

const fail = (msg) => {
  console.error(`e2e FAIL: ${msg}`)
  process.exit(1)
}

if (!existsSync(join(DIST, 'index.html'))) fail('dist/ missing — run `npm run build` first')

const server = await serve(DIST)
const port = server.address().port
const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

const pageErrors = []
page.on('pageerror', (err) => pageErrors.push(String(err)))

// Finland: committed snapshot + history, no external feeds needed.
// Hard ceiling so a wedged run fails loudly instead of hanging CI.
const watchdog = setTimeout(() => fail('timed out after 150 s'), 150_000)
watchdog.unref?.()

await page.goto(`http://localhost:${port}/#fi`, { waitUntil: 'load', timeout: 90_000 })
await page.waitForSelector('.mixstrip', { timeout: 60_000 })
await page.waitForFunction(() => window.__ukgridMap?.loaded(), null, { timeout: 60_000 })
// Settle rendering: force one repaint so 'idle' is guaranteed to fire even
// if the map was already idle when we attached the listener.
await page.evaluate(
  () =>
    new Promise((res) => {
      const m = window.__ukgridMap
      const t = setTimeout(res, 8000)
      m.once('idle', () => {
        clearTimeout(t)
        res(null)
      })
      m.triggerRepaint()
    }),
)
await page.waitForTimeout(500)

const checks = await page.evaluate(() => {
  const m = window.__ukgridMap
  return {
    canvas: Boolean(document.querySelector('canvas.maplibregl-canvas')),
    stations: m.queryRenderedFeatures(undefined, { layers: ['stations'] }).length,
    lines: ['lines-t1', 'lines-t2', 'lines-t3'].some(
      (l) => m.getLayer(l) && m.queryRenderedFeatures(undefined, { layers: [l] }).length > 0,
    ),
    stripTitle: document.querySelector('.mixstrip-title')?.textContent ?? '',
  }
})

if (!checks.canvas) fail('map canvas missing')
if (checks.stations < 50) fail(`only ${checks.stations} stations rendered (expected hundreds)`)
if (!checks.lines) fail('no transmission lines rendered')
if (!/Finland/.test(checks.stripTitle)) fail(`mix strip title wrong: "${checks.stripTitle}"`)
if (pageErrors.length) fail(`uncaught page errors:\n${pageErrors.join('\n')}`)

clearTimeout(watchdog)
console.log(
  `e2e OK: canvas ✓ · ${checks.stations} stations · lines ✓ · strip "${checks.stripTitle.trim()}" · 0 page errors`,
)
await browser.close()
server.close()
