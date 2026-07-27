// Concurrency limiter for the Elexon fan-outs (#9).
import { describe, expect, it } from 'vitest'
import { pooled } from './pool'

const tick = (n = 1) => new Promise((r) => setTimeout(r, n))

describe('pooled', () => {
  it('never runs more than `limit` tasks at once', async () => {
    let inFlight = 0
    let peak = 0
    const items = Array.from({ length: 20 }, (_, i) => i)
    await pooled(items, 4, async (i) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await tick(i % 3)
      inFlight--
      return i
    })
    expect(peak).toBe(4)
  })

  it('returns results in input order regardless of completion order', async () => {
    const items = [30, 5, 20, 1, 10]
    const settled = await pooled(items, 3, async (ms) => {
      await tick(ms)
      return ms
    })
    expect(settled.map((s) => (s.status === 'fulfilled' ? s.value : null))).toEqual(items)
  })

  it('settles rather than rejecting when a task throws', async () => {
    const settled = await pooled([1, 2, 3, 4], 2, async (n) => {
      await tick()
      if (n === 2) throw new Error(`boom ${n}`)
      return n * 10
    })
    expect(settled.map((s) => s.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
    ])
    expect(settled[0]).toEqual({ status: 'fulfilled', value: 10 })
    expect(settled[1]!.status === 'rejected' && String(settled[1]!.reason)).toContain('boom 2')
    expect(settled[3]).toEqual({ status: 'fulfilled', value: 40 })
  })

  it('handles an empty list and a nonsense limit', async () => {
    expect(await pooled([], 4, async () => 1)).toEqual([])
    const settled = await pooled([1, 2], 0, async (n) => n)
    expect(settled.map((s) => (s.status === 'fulfilled' ? s.value : null))).toEqual([1, 2])
  })
})
