// @vitest-environment jsdom
// track() (#97): one integer per event, and never a thrown error.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { track } from './analytics'

type GC = { goatcounter?: { count?: (o: unknown) => void } }

afterEach(() => {
  delete (window as GC).goatcounter
})

describe('track', () => {
  it('is a no-op without the beacon (localhost, blockers)', () => {
    expect(() => track('slider-play')).not.toThrow()
  })

  it('counts an event with the detail folded into the path', () => {
    const count = vi.fn()
    ;(window as GC).goatcounter = { count }
    track('mix-range', 'week')
    expect(count).toHaveBeenCalledWith({ path: 'mix-range-week', title: 'mix-range', event: true })
    track('compare-open')
    expect(count).toHaveBeenCalledWith({ path: 'compare-open', title: 'compare-open', event: true })
  })

  it('swallows a throwing beacon', () => {
    ;(window as GC).goatcounter = {
      count: () => {
        throw new Error('beacon exploded')
      },
    }
    expect(() => track('embed', 'de')).not.toThrow()
  })
})
