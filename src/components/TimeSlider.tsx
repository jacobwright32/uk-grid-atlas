import { useEffect, useRef } from 'react'
import { slotLabel } from '../lib/format'

interface Props {
  /** Intervals in the metered day (GB half-hours — 46/48/50 on clock-change
   *  days (#5) — or 24 hourly EU). */
  len: number
  /** Current interval, or null when showing live/day-average (no scrub). */
  index: number | null
  playing: boolean
  meteredDate: string | null
  /** Week mode (#65): calendar day per 24 slots — labels + faster playback. */
  weekDates?: string[] | null
  onChange: (index: number) => void
  onPlayToggle: () => void
  onReset: () => void
}

const fmtDay = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })

/**
 * Scrub the metered day (#17) or, when the mix strip is on its week view,
 * the whole week hourly (#65). Pure client-side playback — no new fetches.
 */
export default function TimeSlider({
  len,
  index,
  playing,
  meteredDate,
  weekDates,
  onChange,
  onPlayToggle,
  onReset,
}: Props) {
  const week = weekDates ?? null
  // GB days are half-hourly; clock-change days run 46 or 50 periods (#5).
  const stepMin = !week && len >= 46 && len <= 50 ? 30 : 60
  const i = index ?? 0

  // Playback loop — a week has ~7× the steps, so it plays ~2× faster.
  const cb = useRef({ onChange, index, len })
  cb.current = { onChange, index, len }
  useEffect(() => {
    if (!playing) return
    const t = setInterval(
      () => {
        const { onChange, index, len } = cb.current
        onChange(((index ?? -1) + 1) % len)
      },
      week ? 220 : 450,
    )
    return () => clearInterval(t)
  }, [playing, week])

  // Same helper MixStrip labels its scrub with, so the two readouts agree on
  // clock-change days instead of the slider drifting an hour off (#5). Week
  // mode is hourly EU slots within a day, so it takes the plain arithmetic path.
  const clock = week ? slotLabel(i % 24, 60, null) : slotLabel(i, stepMin, meteredDate)
  const dateLabel = week
    ? fmtDay(week[Math.min(week.length - 1, Math.floor(i / 24))] ?? '')
    : meteredDate
      ? fmtDay(meteredDate)
      : ''

  return (
    <div
      className="timeslider"
      role="group"
      aria-label={week ? 'Scrub the past week' : 'Scrub the metered day'}
    >
      <button
        type="button"
        className="timeslider-play"
        aria-label={playing ? 'Pause playback' : week ? 'Play the week' : 'Play the metered day'}
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
        aria-label={week ? 'Hour of the week' : 'Time of day'}
        aria-valuetext={week ? `${dateLabel} ${clock}` : clock}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="timeslider-label">
        {dateLabel} · {index == null ? (week ? 'week view' : 'day view') : clock}
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
