// @vitest-environment jsdom
// Time slider smoke (#63): day vs week labelling and the change plumbing.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import TimeSlider from './TimeSlider'

afterEach(cleanup)

const base = {
  len: 24,
  index: null,
  playing: false,
  meteredDate: '2026-07-24',
  onChange: () => {},
  onPlayToggle: () => {},
  onReset: () => {},
}

describe('TimeSlider (day mode)', () => {
  it('labels the metered day and shows "day view" at rest', () => {
    const { container } = render(<TimeSlider {...base} />)
    // JSX splits the label into text nodes — assert the joined content
    expect(container.querySelector('.timeslider-label')?.textContent).toMatch(
      /Fri,? 24 Jul · day view/,
    )
  })
  it('shows HH:MM while scrubbing and a reset affordance', () => {
    render(<TimeSlider {...base} index={14} />)
    expect(screen.getByText(/14:00/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Back to the live/ })).toBeTruthy()
  })
  it('GB half-hourly days step in 30-minute labels', () => {
    render(<TimeSlider {...base} len={48} index={3} />)
    expect(screen.getByText(/01:30/)).toBeTruthy()
  })
  it('forwards slider input to onChange', () => {
    const onChange = vi.fn()
    render(<TimeSlider {...base} onChange={onChange} />)
    fireEvent.change(screen.getByRole('slider'), { target: { value: '7' } })
    expect(onChange).toHaveBeenCalledWith(7)
  })
})

describe('TimeSlider (week mode, #65)', () => {
  const week = {
    ...base,
    len: 72,
    weekDates: ['2026-07-22', '2026-07-23', '2026-07-24'],
  }
  it('labels the calendar day for the scrubbed slot', () => {
    const { container } = render(<TimeSlider {...week} index={30} />) // day 2, 06:00
    expect(container.querySelector('.timeslider-label')?.textContent).toMatch(
      /Thu,? 23 Jul · 06:00/,
    )
  })
  it('shows "week view" at rest and a week-scoped group label', () => {
    render(<TimeSlider {...week} />)
    expect(screen.getByText(/week view/)).toBeTruthy()
    expect(screen.getByRole('group', { name: /Scrub the past week/ })).toBeTruthy()
  })
})
