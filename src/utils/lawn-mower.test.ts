import { describe, expect, it, vi } from 'vitest'

import {
  isLawnMowerDevice,
  isMowerDockJobStale,
  isOpenMowerJob,
  isPausedCleanReport,
  MOWER_DOCK_STALE_JOB_MS,
  nextMowerDockedAtMs,
  resolveMowerPlayAction,
  runMowerCleanAction,
} from './lawn-mower.js'

describe('isLawnMowerDevice', () => {
  it('detects the GOAT O500 Panorama from cloud device fields', () => {
    expect(isLawnMowerDevice({
      class: '300lc5',
      deviceName: 'GOAT O500 Panorama',
      model: 'GOAT_BAIZE_500_EU',
      product_category: 'GOATBOT',
      UILogicId: 'goatl_ww_h_goatbz',
    })).toBe(true)
  })

  it('detects by known device class alone', () => {
    expect(isLawnMowerDevice({ class: '300lc5' })).toBe(true)
  })

  it('does not treat a normal vacuum as a mower', () => {
    expect(isLawnMowerDevice({
      class: 'yna5xi',
      deviceName: 'DEEBOT X1 OMNI',
      product_category: 'DEEBOT',
      UILogicId: 'x1_omni',
    })).toBe(false)
  })
})

describe('runMowerCleanAction', () => {
  it('sends clean with V2-style content on the Generic path', () => {
    const run = vi.fn()
    runMowerCleanAction({ run }, 'start')
    expect(run).toHaveBeenCalledWith('Generic', 'clean', {
      act: 'start',
      content: { type: 'auto' },
    })
  })

  it('echoes the clean type for stop', () => {
    const run = vi.fn()
    runMowerCleanAction({ run }, 'stop', 'spotArea')
    expect(run).toHaveBeenCalledWith('Generic', 'clean', {
      act: 'stop',
      content: { type: 'spotArea' },
    })
  })
})

describe('isPausedCleanReport', () => {
  it('recognises pause / paused CleanReport values', () => {
    expect(isPausedCleanReport('pause')).toBe(true)
    expect(isPausedCleanReport('Paused')).toBe(true)
    expect(isPausedCleanReport('auto')).toBe(false)
    expect(isPausedCleanReport('idle')).toBe(false)
  })
})

describe('isOpenMowerJob', () => {
  it('treats active, paused, and returning as an open job', () => {
    expect(isOpenMowerJob('auto')).toBe(true)
    expect(isOpenMowerJob('pause')).toBe(true)
    expect(isOpenMowerJob('returning')).toBe(true)
  })

  it('treats idle / stop as no open job', () => {
    expect(isOpenMowerJob('idle')).toBe(false)
    expect(isOpenMowerJob('stop')).toBe(false)
  })
})

describe('isMowerDockJobStale', () => {
  it('treats a missing dock timestamp as stale (safe after restart)', () => {
    expect(isMowerDockJobStale(undefined)).toBe(true)
    expect(isMowerDockJobStale(null)).toBe(true)
  })

  it('keeps a recent rain/charge dock resumable', () => {
    const dockedAt = 1_000_000
    expect(isMowerDockJobStale(dockedAt, dockedAt + 10 * 60 * 1000)).toBe(false)
    expect(isMowerDockJobStale(dockedAt, dockedAt + MOWER_DOCK_STALE_JOB_MS - 1)).toBe(false)
  })

  it('marks overnight dock as stale', () => {
    const dockedAt = 1_000_000
    expect(isMowerDockJobStale(dockedAt, dockedAt + MOWER_DOCK_STALE_JOB_MS)).toBe(true)
  })
})

describe('nextMowerDockedAtMs', () => {
  it('starts a fresh window when arriving from off-dock (leave then return)', () => {
    // Docked 12:01, left to mow (Running), returns 12:56 — must not keep 12:01.
    const firstDockAt = 1_000_000
    const returnAt = firstDockAt + 55 * 60 * 1000
    expect(nextMowerDockedAtMs({
      previousOperationalState: 1, // was Running
      existingDockedAtMs: firstDockAt,
      nowMs: returnAt,
    })).toBe(returnAt)
  })

  it('starts a fresh window when arriving after returning home', () => {
    const returnAt = 2_000_000
    expect(nextMowerDockedAtMs({
      previousOperationalState: 64, // SeekingCharger
      existingDockedAtMs: undefined,
      nowMs: returnAt,
    })).toBe(returnAt)
  })

  it('keeps the stamp when ChargeState re-reports while already on the dock', () => {
    const dockedAt = 1_000_000
    expect(nextMowerDockedAtMs({
      previousOperationalState: 65, // already Charging
      existingDockedAtMs: dockedAt,
      nowMs: dockedAt + 10 * 60 * 1000,
    })).toBe(dockedAt)
  })
})

describe('resolveMowerPlayAction', () => {
  const recentDock = 1_000_000
  const withinHour = recentDock + 15 * 60 * 1000
  const afterHour = recentDock + MOWER_DOCK_STALE_JOB_MS

  it('resumes when a job is in progress off the dock (paused on lawn)', () => {
    expect(resolveMowerPlayAction({
      hasOpenJob: true,
      onDock: false,
    })).toEqual({ action: 'resume', endFirst: false })
  })

  it('resumes when a job is in progress and docked under 1 hour', () => {
    expect(resolveMowerPlayAction({
      hasOpenJob: true,
      onDock: true,
      dockedAtMs: recentDock,
      nowMs: withinHour,
    })).toEqual({ action: 'resume', endFirst: false })
  })

  it('starts fresh when idle on the dock within 1 hour (no job in progress)', () => {
    expect(resolveMowerPlayAction({
      hasOpenJob: false,
      onDock: true,
      dockedAtMs: recentDock,
      nowMs: withinHour,
    })).toEqual({ action: 'start', endFirst: false })
  })

  it('starts fresh when idle and not on the dock', () => {
    expect(resolveMowerPlayAction({
      hasOpenJob: false,
      onDock: false,
    })).toEqual({ action: 'start', endFirst: false })
  })

  it('ends then starts fresh after a long dock with a mid-job still open', () => {
    expect(resolveMowerPlayAction({
      hasOpenJob: true,
      onDock: true,
      dockedAtMs: recentDock,
      nowMs: afterHour,
    })).toEqual({ action: 'start', endFirst: true })
  })

  it('starts fresh when idle even after a long dock', () => {
    expect(resolveMowerPlayAction({
      hasOpenJob: false,
      onDock: true,
      dockedAtMs: recentDock,
      nowMs: afterHour,
    })).toEqual({ action: 'start', endFirst: false })
  })
})
