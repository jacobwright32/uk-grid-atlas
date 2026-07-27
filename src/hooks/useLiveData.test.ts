// @vitest-environment jsdom
// ENTSO-E snapshot freshness (#4): the workflow re-bakes every 6 h, so a
// successful snapshot has to expire too — a session left open used to sit on
// whichever metered day it happened to open with, forever.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { LiveData } from '../lib/live'
import type { CountryConfig } from '../lib/countries'

const mocks = vi.hoisted(() => ({ loadEntsoeSnapshot: vi.fn() }))
vi.mock('../lib/live', () => ({
  loadEntsoeSnapshot: mocks.loadEntsoeSnapshot,
  loadLive: vi.fn(),
  fetchMixNow: vi.fn(),
}))

const { useLiveData } = await import('./useLiveData')

/** The hook only reads `id` and `liveKind`. */
const entsoe = (id: string) => ({ id, liveKind: 'entsoe' }) as unknown as CountryConfig

const snapshot = (meteredDate: string) => ({ meteredDate }) as unknown as LiveData

let now = 1_700_000_000_000

beforeEach(() => {
  now = 1_700_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  mocks.loadEntsoeSnapshot.mockReset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** Mount, let the snapshot promise settle, and hand back the final state. */
async function mount(country: CountryConfig) {
  const view = renderHook(() => useLiveData(country))
  await act(async () => {})
  return view
}

describe('useLiveData ENTSO-E snapshot TTL (#4)', () => {
  it('serves the cache without re-fetching inside the TTL, then re-checks after it', async () => {
    // The cache is module-level, so every test needs its own country id.
    const country = entsoe('ttl-a')
    mocks.loadEntsoeSnapshot.mockResolvedValue(snapshot('2026-07-20'))

    const first = await mount(country)
    expect(first.result.current.status).toBe('live')
    expect(mocks.loadEntsoeSnapshot).toHaveBeenCalledTimes(1)
    first.unmount()

    // Well inside the 15-minute TTL: cached, no request.
    now += 14 * 60_000
    const second = await mount(country)
    expect(second.result.current.status).toBe('live')
    expect(mocks.loadEntsoeSnapshot).toHaveBeenCalledTimes(1)
    second.unmount()

    // Past it: one cheap re-check picks up the newer bake.
    now += 2 * 60_000
    mocks.loadEntsoeSnapshot.mockResolvedValue(snapshot('2026-07-21'))
    const third = await mount(country)
    expect(mocks.loadEntsoeSnapshot).toHaveBeenCalledTimes(2)
    expect(third.result.current.live?.meteredDate).toBe('2026-07-21')
  })

  it('shows the stale snapshot immediately and keeps it when the re-check fails', async () => {
    const country = entsoe('ttl-b')
    mocks.loadEntsoeSnapshot.mockResolvedValue(snapshot('2026-07-20'))
    const first = await mount(country)
    expect(first.result.current.status).toBe('live')
    first.unmount()

    now += 20 * 60_000
    mocks.loadEntsoeSnapshot.mockResolvedValue(null)
    const view = renderHook(() => useLiveData(country))
    // Before the re-check resolves: the stale snapshot is already on screen
    // rather than a blank "loading" pane.
    expect(view.result.current.status).toBe('live')
    await act(async () => {})
    // …and a failed re-check leaves it there instead of blanking a working view.
    expect(view.result.current.status).toBe('live')
    expect(view.result.current.live?.meteredDate).toBe('2026-07-20')
  })

  it('expires a failure on the short retry clock, not the snapshot TTL', async () => {
    const country = entsoe('ttl-c')
    mocks.loadEntsoeSnapshot.mockResolvedValue(null)
    const first = await mount(country)
    expect(first.result.current.status).toBe('unavailable')
    expect(mocks.loadEntsoeSnapshot).toHaveBeenCalledTimes(1)
    first.unmount()

    now += 30_000 // inside FAIL_TTL
    const second = await mount(country)
    expect(mocks.loadEntsoeSnapshot).toHaveBeenCalledTimes(1)
    second.unmount()

    now += 40_000 // past it — a transient blip must not wedge the session
    mocks.loadEntsoeSnapshot.mockResolvedValue(snapshot('2026-07-21'))
    const third = await mount(country)
    expect(mocks.loadEntsoeSnapshot).toHaveBeenCalledTimes(2)
    expect(third.result.current.status).toBe('live')
  })
})
