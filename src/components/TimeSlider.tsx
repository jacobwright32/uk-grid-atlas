import { useEffect, useRef } from 'react'

interface Props {
  /** Number of intervals in the metered day (48 half-hourly GB, 24 hourly EU). */
  len: number
  /** Current interval, or null when showing live/day-average (no scrub). */
  index: number | null
  playing: boolean
  meteredDate: string | null
  onChange: (index: number) => void
  onPlayToggle: () => void
  onReset: () => void
}

/**
 * Scrub the metered day (#17). Both snapshot families already ship full
 * per-station series, so this is pure client-side playback — no new fetches.
 */
export default function TimeSlider({
  len,
  index,
  playing,
  meteredDate,
  onChange,
  onPlayToggle,
  onReset,
}: Props) {
  const stepMin = len === 48 ? 30 : 60
  const i = index ?? 0

  // Playback loop.
  const cb = useRef({ onChange, index, len })
  cb.current = { onChange, index, len }
  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => {
      const { onChange, index, len } = cb.current
      onChange(((index ?? -1) + 1) % len)
    }, 450)
    return () => clearInterval(t)
  }, [playing])

  const mins = i * stepMin
  const hh = String(Math.floor(mins / 60)).padStart(2, '0')
  const mm = String(mins % 60).padStart(2, '0')
  const dateLabel = meteredDate
    ? new Date(`${meteredDate}T12:00:00Z`).toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      })
    : ''

  return (
    <div className="timeslider" role="group" aria-label="Scrub the metered day">
      <button
        type="button"
        className="timeslider-play"
        aria-label={playing ? 'Pause playback' : 'Play the metered day'}
        onClick={onPlayToggle}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <input
        type="range"
        className="timeslider-range"
        min={0}
        max={len - 1}
        step={1}
        value={i}
        aria-label="Time of day"
        aria-valuetext={`${hh}:${mm}`}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="timeslider-label">
        {dateLabel} · {index == null ? 'day view' : `${hh}:${mm}`}
      </span>
      {index != null && (
        <button
          type="button"
          className="timeslider-reset"
          onClick={onReset}
          aria-label="Back to the live / day-average view"
        >
          reset
        </button>
      )}
    </div>
  )
}
