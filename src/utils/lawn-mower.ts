/**
 * Ecovacs GOAT lawn mowers share the vacuum MQTT API but need a different
 * start/pause/stop payload: the `clean` command with a V2-style `content`
 * object. The vacuum `Clean` / `Clean_V2` shapes are ignored by GOAT firmware
 * (same defect Home Assistant's deebot-client hit with CleanMower).
 *
 * See: DeebotUniverse/client.py CleanMower — NAME "clean",
 * args { act, content: { type } }.
 *
 * Docking does not clear a mid-job on its own (the Ecovacs app still shows
 * End / Continue). Short dock breaks (rain, charge) should Resume; after a
 * long stay on the dock the mid-job is treated as stale and Ended so the
 * next Home play is a fresh start.
 */

/** Device class ids known to be GOAT lawn mowers (ecovacs-deebot-alpha). */
const KNOWN_MOWER_CLASSES = new Set([
  '0jbd6s',
  '2ap5uq',
  '2i0fns',
  '2px96q',
  '300lc5',
  '51rcxt',
  '5xu9h3',
  '6cibhb',
  '6n9pcz',
  '77atlz',
  '9bts2s',
  'aadham',
  'ao7fpw',
  'cr0e4u',
  'e4gqia',
  'guzput',
  'itk04l',
  'neiwny',
  'o4kvvk',
  'qhq6i0',
  's69g6z',
  'wwswjm',
  'xmp9ds',
])

export type MowerCleanAction = 'start' | 'pause' | 'resume' | 'stop'

export interface LawnMowerDeviceHints {
  class?: string
  deviceName?: string
  model?: string
  product_category?: string
  UILogicId?: string
}

/**
 * Whether an Ecovacs cloud device object looks like a GOAT lawn mower.
 */
export function isLawnMowerDevice(device: LawnMowerDeviceHints): boolean {
  if (device.product_category?.toUpperCase() === 'GOATBOT') {
    return true
  }
  if (device.UILogicId?.toLowerCase().startsWith('goat')) {
    return true
  }
  if (device.class && KNOWN_MOWER_CLASSES.has(device.class)) {
    return true
  }
  const label = `${device.deviceName || ''} ${device.model || ''}`.toLowerCase()
  return label.includes('goat')
}

/** Normalize CleanReport / motion-state strings for comparisons. */
export function normalizeCleanReport(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * CleanReport values that look like pause.
 *
 * GOAT pushes `motionState: "pause"` for a real pause (app, rain, etc.) and
 * `motionState: "working"` while cutting — same mapping Home Assistant uses.
 * The older "pause for hours while mowing" note was the broken `getCleanInfo`
 * poll always answering `idle`, not the live push.
 */
export function isPausedCleanReport(value: string): boolean {
  const normalized = normalizeCleanReport(value)
  return normalized === 'pause' || normalized === 'paused'
}

/**
 * Whether CleanReport means a job is still open (active, paused, or returning).
 */
export function isOpenMowerJob(cleanReport: string): boolean {
  const normalized = normalizeCleanReport(cleanReport)
  if (isPausedCleanReport(normalized)) {
    return true
  }
  return [
    'auto',
    'clean',
    'edge',
    'spot',
    'spotarea',
    'customarea',
    'spotareav2',
    'customareav2',
    'mapping',
    'returning',
    'gocharging',
  ].includes(normalized)
}

/**
 * How long a GOAT may sit on the dock with a mid-job still open before we
 * treat that job as stale. Shorter breaks (rain, top-up charge) stay resumable;
 * overnight / next-day Home play should be a fresh start.
 */
export const MOWER_DOCK_STALE_JOB_MS = 12 * 60 * 60 * 1000

/**
 * True when the mower has been on the dock long enough that the open mid-job
 * should be Ended. Missing `dockedAtMs` (e.g. plugin restart while docked) is
 * treated as stale so Home play does not get stuck needing the Ecovacs app End.
 */
export function isMowerDockJobStale(
  dockedAtMs: number | undefined | null,
  nowMs = Date.now(),
): boolean {
  if (dockedAtMs == null) {
    return true
  }
  return nowMs - dockedAtMs >= MOWER_DOCK_STALE_JOB_MS
}

/** Matter rvcOperationalState ids used for docked / charging. */
const MOWER_ON_DOCK_STATES = new Set([65, 66])

/**
 * Timestamp for the current dock stay.
 *
 * Must reset on every physical arrival. Otherwise: dock 12:01 → leave to mow
 * → return 12:56 still holds 12:01, and at 13:01 we wrongly treat it as a
 * 1-hour stay and End the job. Keep the existing stamp only when ChargeState
 * re-reports charging/docked while we were already on the dock.
 */
export function nextMowerDockedAtMs(options: {
  /** Operational state before this ChargeState update. */
  previousOperationalState: number
  existingDockedAtMs?: number | null
  nowMs?: number
}): number {
  const {
    previousOperationalState,
    existingDockedAtMs,
    nowMs = Date.now(),
  } = options
  const wasAlreadyOnDock = MOWER_ON_DOCK_STATES.has(previousOperationalState)
  if (wasAlreadyOnDock && existingDockedAtMs != null) {
    return existingDockedAtMs
  }
  return nowMs
}

export interface MowerPlayDecision {
  /** Command to send for Home/Matter play. */
  action: 'start' | 'resume'
  /** When true, send act:stop (End) before act:start — stale docked mid-job. */
  endFirst: boolean
}

/**
 * Decide start vs resume for a GOAT Home/Matter play.
 *
 * Within the 1-hour dock window (and anytime off-dock):
 *   - job in progress (`hasOpenJob`) → `resume`
 *   - no job in progress → `start`
 *
 * After ≥ 1 hour on the dock with a mid-job still open:
 *   - End (`stop`) then fresh `start` (next-day Home play)
 */
export function resolveMowerPlayAction(options: {
  /** True when a mid-job is still open (mowing, paused, returning, short dock). */
  hasOpenJob: boolean
  /** True when the mower is on the dock (charging / docked). */
  onDock: boolean
  /** When the current dock stay began; used only for the stale-job window. */
  dockedAtMs?: number | null
  nowMs?: number
}): MowerPlayDecision {
  const {
    hasOpenJob,
    onDock,
    dockedAtMs,
    nowMs = Date.now(),
  } = options

  if (!hasOpenJob) {
    // Idle — always a fresh start (whether on the dock or not).
    return { action: 'start', endFirst: false }
  }

  // Mid-job still open.
  if (onDock && isMowerDockJobStale(dockedAtMs, nowMs)) {
    // Sat on the dock too long — End leftover, then start fresh.
    return { action: 'start', endFirst: true }
  }

  // In progress: paused on lawn, returning, or docked &lt; 1 hour (rain/charge).
  return { action: 'resume', endFirst: false }
}

/** Send a GOAT-compatible clean action via the library's Generic command. */
export function runMowerCleanAction(
  control: { run: (...args: any[]) => void },
  action: MowerCleanAction,
  cleanType = 'auto',
): void {
  control.run('Generic', 'clean', {
    act: action,
    content: { type: cleanType },
  })
}
