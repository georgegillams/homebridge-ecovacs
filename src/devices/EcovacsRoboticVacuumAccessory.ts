/**
 * Ecovacs Robotic Vacuum Cleaner - Matter Accessory
 *
 * Bridges the Ecovacs/Yeedi vacbot device to the Matter RoboticVacuumCleaner
 * device type (Matter Spec § 12.1), enabling native Matter commissioning via
 * Apple Home and other Matter ecosystems.
 *
 * Cluster mapping:
 *   rvcRunMode ← CleanReport events (Idle / Cleaning / Mapping)
 *   rvcOperationalState ← ChargeState events (Stopped / Running / Paused /
 *                         SeekingCharger / Charging / Docked)
 *   rvcCleanMode ← CleanSpeed events (Vacuum / Max Clean)
 *   serviceArea ← configured spot-area IDs in plugin config
 *
 * Handler mapping (Matter → Ecovacs commands):
 *   rvcRunMode.changeToMode (1=Cleaning) → run('Clean' | 'Clean_V2') / GOAT play
 *   rvcRunMode.changeToMode (0=Idle) → run('Charge')
 *   rvcOperationalState.pause → run('Pause') / GOAT act:pause
 *   rvcOperationalState.resume → run('Resume') / GOAT act:resume
 *   rvcOperationalState.goHome → run('Charge')
 *
 * GOAT note: docking does not clear a mid-job. Short docks (rain/charge) stay
 * resumable; after {@link MOWER_DOCK_STALE_JOB_MS} on the dock we End so the
 * next Home play is a fresh start. Never End immediately on ChargeState —
 * that races start-from-dock and Ecovacs-app starts.
 *
 * GOAT app pause/resume: arrives on `onScheduleTaskInfo` (rewritten to
 * CleanInfo via {@link patchGoatMqttMessages}). Do not poll GetCleanState —
 * GOAT always answers idle.
 */

import type { API, Logger, MatterRequests } from 'homebridge'

import { patchGoatMqttMessages } from '../utils/goat-mqtt.js'
import platformLang from '../utils/lang-en.js'
import {
  isOpenMowerJob,
  isPausedCleanReport,
  MOWER_DOCK_STALE_JOB_MS,
  nextMowerDockedAtMs,
  normalizeCleanReport,
  resolveMowerPlayAction,
  runMowerCleanAction,
} from '../utils/lawn-mower.js'
import { BaseMatterAccessory } from './BaseMatterAccessory.js'

/** Ecovacs clean-state values that indicate the vacuum is actively cleaning. */
const CLEANING_STATES = new Set([
  'auto',
  'clean',
  'edge',
  'spot',
  'spotarea',
  'customarea',
  'spotarea_v2',
  'customarea_v2',
  'mapping',
])

export interface EcovacsDeviceInfo {
  /** Unique device ID (used for UUID generation and serial number). */
  did: string
  /** Device display name / nickname. */
  nick: string
  /** Device manufacturer string. */
  company: string
  /** Device model string. */
  model: string
  /** Optional firmware version string. */
  fwVersion?: string
  /** Whether the device uses V2 commands (950-type). */
  isV2?: boolean
  /** Whether this is an Ecovacs GOAT lawn mower. */
  isLawnMower?: boolean
}

/**
 * Matter accessory for an Ecovacs robotic vacuum cleaner.
 *
 * Create one instance per physical device and call {@link connectControl}
 * once the vacbot `control` object is ready (after `control.connect()`).
 */
export class EcovacsRoboticVacuumAccessory extends BaseMatterAccessory {
  private control: any = null

  private readonly isV2?: boolean

  private readonly isLawnMower?: boolean

  /** Tracked so we can guard handler state checks. */
  private currentOperationalState = 66 // start docked

  /** Last CleanReport string (normalized), for GOAT mid-job detection. */
  private lastCleanReport = ''

  /**
   * True while a GOAT job is active/paused/returning. Cleared when we End a
   * stale docked job or CleanReport goes idle.
   */
  private hasOpenJob = false

  /**
   * Date.now() when the GOAT first arrived on the dock with an open mid-job.
   * Used to decide resume (recent rain/charge) vs End+start (stale / next day).
   */
  private mowerDockedAtMs: number | undefined

  /** Timer that Ends a mid-job after {@link MOWER_DOCK_STALE_JOB_MS} on the dock. */
  private staleDockEndTimer: ReturnType<typeof setTimeout> | undefined

  /** Accumulated map data: mapId → mapName */
  private readonly mapsById = new Map<number, string>()
  /** Accumulated area data: areaId → { mapId, name } */
  private readonly areasById = new Map<number, { mapId: number, name: string }>()
  /** One-time note flag for the optional canvas module being unbuilt */
  private canvasNoteShown = false

  // The last device error reported, so a robot that is simply switched off does
  // not warn on every command the plugin sends. The HAP path already does this
  private lastReportedError = ''

  /** Last battery % logged, so repeated BatteryInfo pushes do not spam the log. */
  private lastLoggedBattery: number | undefined

  /** Last CleanSpeed logged for the same reason. */
  private lastLoggedCleanSpeed: number | undefined

  constructor(api: API, log: Logger, device: EcovacsDeviceInfo) {
    const serialNumber = device.did
    const isV2 = device.isV2 ?? false
    const isLawnMower = device.isLawnMower ?? false
    const manufacturer = device.company || 'Ecovacs'
    const rawModel = device.model || 'Deebot'

    if (!api.matter) {
      return
    }

    // Matter spec: productLabel (defaults to productName/model) must not include vendorName
    const escapedMfr = manufacturer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const model = rawModel.replace(new RegExp(escapedMfr, 'i'), '').trim() || rawModel

    // Matter caps serial numbers at 32 characters and UUID-style DIDs are 36,
    // so drop the dashes (leaving exactly 32 hex characters) rather than let
    // the core truncate with a warning on every load. The accessory UUID
    // still derives from the full DID so existing pairings are unaffected.
    const matterSerial = serialNumber.replace(/-/g, '').substring(0, 32)

    super(api, log, {
      UUID: api.matter.uuid.generate(`ecovacs-${serialNumber}`),
      displayName: device.nick || device.did,
      deviceType: api.matter.deviceTypes.RoboticVacuumCleaner,
      serialNumber: matterSerial,
      manufacturer,
      model,
      firmwareRevision: device.fwVersion || '1.0.0',
      hardwareRevision: '1.0.0',
      context: { ecoDeviceId: device.did },

      clusters: {
        // ── Run Mode ──────────────────────────────────────────────────
        rvcRunMode: {
          supportedModes: [
            { label: 'Idle', mode: 0, modeTags: [{ value: 16384 }] },
            { label: 'Cleaning', mode: 1, modeTags: [{ value: 16385 }] },
            { label: 'Mapping', mode: 2, modeTags: [{ value: 16386 }] },
          ],
          currentMode: 0,
        },

        // ── Clean Mode ────────────────────────────────────────────────
        // Only Vacuum (standard) and Max Clean (high power) are currently
        // driven by Ecovacs CleanSpeed events. The device does not yet report
        // Mop / Vacuum & Mop modes, so omitted to avoid a stale state.
        rvcCleanMode: {
          supportedModes: [
            { label: 'Vacuum', mode: 0, modeTags: [{ value: 16385 }] },
            { label: 'Max Clean', mode: 3, modeTags: [{ value: 7 }, { value: 16385 }] },
          ],
          currentMode: 0,
        },

        // ── Operational State ─────────────────────────────────────────
        rvcOperationalState: {
          operationalStateList: [
            { operationalStateId: 0 }, // Stopped
            { operationalStateId: 1 }, // Running
            { operationalStateId: 2 }, // Paused
            { operationalStateId: 3 }, // Error
            { operationalStateId: 64 }, // SeekingCharger
            { operationalStateId: 65 }, // Charging
            { operationalStateId: 66 }, // Docked
          ],
          operationalState: 66, // start docked
        },

        // ── Power Source (battery) ────────────────────────────────────
        powerSource: {
          status: 0, // unknown until first BatteryInfo event
          order: 0,
          description: 'Battery',
          batPercentRemaining: 0, // half-percent units (0-200)
          batChargeLevel: 0, // 0 = OK, 1 = Warning, 2 = Critical
        },

        // ── Service Area (populated from device config if available) ──
        serviceArea: {
          supportedMaps: [],
          supportedAreas: [],
          selectedAreas: [],
        },
      },

      handlers: {
        rvcRunMode: {
          changeToMode: async (request: MatterRequests.ChangeToMode) =>
            this.handleChangeRunMode(request),
        },
        rvcCleanMode: {
          changeToMode: async (request: MatterRequests.ChangeToMode) =>
            this.handleChangeCleanMode(request),
        },
        rvcOperationalState: {
          pause: async () => this.handlePause(),
          resume: async () => this.handleResume(),
          goHome: async () => this.handleGoHome(),
        },
        serviceArea: {
          selectAreas: async (request: MatterRequests.SelectAreas) =>
            this.handleSelectAreas(request),
          skipArea: async (request: MatterRequests.SkipArea) =>
            this.handleSkipArea(request),
        },
      },
    })

    this.isV2 = isV2
    this.isLawnMower = isLawnMower
    this.logInfo('Matter accessory initialized (waiting for device connection).')
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Device connection
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Attach to the live vacbot control object and start listening for events.
   * Call this after `loadedDevice.connect()` in the platform's initialiseDevice.
   */
  public connectControl(control: any): void {
    this.control = control

    // GOAT pause/resume from the Ecovacs app arrives on onScheduleTaskInfo,
    // which ecovacs-deebot otherwise drops as an unknown MQTT topic.
    if (this.isLawnMower && !patchGoatMqttMessages(control, msg => this.logInfo(msg))) {
      this.logDebug('Could not patch GOAT MQTT topics — app pause/resume may not sync.')
    }

    // ── Device ready: fetch initial state ────────────────────────────
    control.on('ready', (event: boolean) => {
      if (!event) {
        return
      }
      this.logDebug('Device ready — requesting initial state.')
      control.run('GetBatteryState')
      control.run('GetChargeState')
      // GOAT answers GetCleanState with idle every time (even mid-run). That
      // would wipe Matter state; rely on ScheduleTaskInfo / CleanInfo pushes.
      if (!this.isLawnMower) {
        control.run(this.isV2 ? 'GetCleanState_V2' : 'GetCleanState')
        control.run('GetCleanSpeed')
        control.run('GetMaps')
      }
    })

    control.on('CleanReport', (newVal: string) => void this.onCleanReport(newVal))
    control.on('ChargeState', (newVal: string) => void this.onChargeState(newVal))
    control.on('BatteryInfo', (newVal: number) => void this.onBatteryInfo(newVal))
    control.on('CleanSpeed', (newVal: number) => void this.onCleanSpeed(newVal))

    // ── Error / offline detection ──────────────────────────────────
    control.on('Error', (err: string) => {
      if (err === 'NoError: Robot is operational') {
        return
      }
      // The optional canvas module only draws map images, which HomeKit
      // never sees - it is commonly unbuilt on user systems (npm 12 blocks
      // its build script), so note it once quietly rather than warn per
      // map event
      if (String(err).includes('canvas.node')) {
        if (!this.canvasNoteShown) {
          this.canvasNoteShown = true
          this.logDebug(platformLang.canvasMissing)
        }
        return
      }
      if (this.lastReportedError !== String(err)) {
        this.lastReportedError = String(err)
        this.logWarn(`Device error: ${err}`)
        if (err === 'Recipient unavailable') {
          this.logWarn('Device appears to be offline.')
        }
      }
      void this.updateOperationalState(3) // Error
    })

    // ── Service area discovery ──────────────────────────────────────
    control.on('Maps', (data: any) => {
      if (!data?.maps) {
        return
      }
      // Register each map and request its spot areas
      Object.values(data.maps).forEach((m: any) => {
        const mapId = Number(m.mapID)
        if (Number.isNaN(mapId)) {
          this.logWarn(`Ignoring map with invalid ID: ${m.mapID}`)
          return
        }
        this.mapsById.set(mapId, m.mapName || `Map ${m.mapID}`)
        control.run('GetSpotAreas', m.mapID)
      })
    })

    control.on('MapSpotAreas', (data: any) => {
      if (!data?.mapSpotAreas) {
        return
      }
      // Request full info for each area
      Object.values(data.mapSpotAreas).forEach((area: any) => {
        control.run('GetSpotAreaInfo', data.mapID, area.mapSpotAreaID)
      })
    })

    control.on('MapSpotAreaInfo', (area: any) => {
      if (!area?.mapSpotAreaID) {
        return
      }
      const areaId = Number(area.mapSpotAreaID)
      const mapId = Number(area.mapID)
      if (Number.isNaN(areaId) || Number.isNaN(mapId)) {
        this.logWarn(`Ignoring area with invalid IDs: area=${area.mapSpotAreaID}, map=${area.mapID}`)
        return
      }
      const name = area.mapSpotAreaName || `Area ${area.mapSpotAreaID}`
      this.areasById.set(areaId, { mapId, name })
      void this.flushServiceAreas()
    })

    // Trigger map discovery after connecting (vacuums only — GOATs time out)
    if (!this.isLawnMower) {
      control.run('GetMaps')
    }

    this.logInfo('Connected to device control — Matter state updates active.')
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Event handlers: Ecovacs → Matter state
  // ──────────────────────────────────────────────────────────────────────────

  /** Maps Ecovacs CleanReport values to Matter rvcRunMode + rvcOperationalState. */
  private async onCleanReport(newVal: string): Promise<void> {
    if (!newVal) {
      this.logDebug('CleanReport received with empty value, ignoring')
      return
    }
    this.logInfo(`${platformLang.receiveCmd} [CleanReport: ${newVal}]`)
    const normalized = normalizeCleanReport(newVal)
    this.lastCleanReport = normalized

    if (CLEANING_STATES.has(normalized)) {
      this.hasOpenJob = true
      this.clearMowerDockTracking()
      await this.updateRunMode(1) // Cleaning
      await this.updateOperationalState(1) // Running
      this.logInfo('Matter state ← clean → Cleaning / Running')
      return
    }

    if (isPausedCleanReport(normalized)) {
      this.hasOpenJob = true
      if (this.isLawnMower) {
        // Returning / on dock: keep SeekingCharger / Charging / Docked.
        // HA withholds PAUSED while the mower is on its charger for the same reason.
        if (
          this.currentOperationalState === 64
          || this.currentOperationalState === 65
          || this.currentOperationalState === 66
        ) {
          this.logInfo(
            `CleanReport pause ignored — keeping dock/return state (operationalState=${this.currentOperationalState})`,
          )
          return
        }
        this.clearMowerDockTracking()
      }
      // Idle + Paused: Apple Home keeps showing "Vacuuming" if rvcRunMode
      // stays Cleaning, even when operationalState is Paused. hasOpenJob
      // still tracks the resumable mid-job for the next play/resume.
      await this.updateRunMode(0) // Idle
      await this.updateOperationalState(2) // Paused
      this.logInfo('Matter state ← pause → Idle / Paused')
      return
    }

    if (normalized === 'returning' || normalized === 'gocharging') {
      if (this.isLawnMower) {
        this.hasOpenJob = true
      }
      await this.updateRunMode(0) // Idle
      await this.updateOperationalState(64) // SeekingCharger
      return
    }

    // idle / stop — job is no longer open
    this.hasOpenJob = false
    this.clearMowerDockTracking()
    await this.updateRunMode(0) // Idle
    if (this.currentOperationalState === 1 || this.currentOperationalState === 2) {
      await this.updateOperationalState(0) // Stopped
    }
  }

  /** Left the dock / job cleared — stop the stale-dock End timer. */
  private clearMowerDockTracking(): void {
    this.mowerDockedAtMs = undefined
    if (this.staleDockEndTimer) {
      clearTimeout(this.staleDockEndTimer)
      this.staleDockEndTimer = undefined
    }
  }

  /**
   * Note arrival on the dock with an open mid-job. Do not End immediately —
   * rain/charge breaks must stay resumable. Schedule End only after
   * {@link MOWER_DOCK_STALE_JOB_MS} so tomorrow's Home play is a fresh start.
   *
   * Each physical arrival gets a fresh timestamp (see {@link nextMowerDockedAtMs}):
   * dock 12:01 → leave → return 12:56 must not still look like a 1h stay at 13:01.
   */
  private noteMowerDockArrival(reason: string): void {
    if (!this.isLawnMower) {
      return
    }
    const open = this.hasOpenJob || isOpenMowerJob(this.lastCleanReport)
    if (!open) {
      return
    }
    this.hasOpenJob = true
    const previousState = this.currentOperationalState
    const nextDockedAt = nextMowerDockedAtMs({
      previousOperationalState: previousState,
      existingDockedAtMs: this.mowerDockedAtMs,
    })
    if (nextDockedAt !== this.mowerDockedAtMs) {
      this.mowerDockedAtMs = nextDockedAt
      this.logDebug(
        `GOAT docked with open job (${reason}) — resumable for ${MOWER_DOCK_STALE_JOB_MS / 60000} min`
        + ` (window started now; was state ${previousState})`,
      )
    }
    this.scheduleStaleDockEnd()
  }

  private scheduleStaleDockEnd(): void {
    if (this.staleDockEndTimer) {
      clearTimeout(this.staleDockEndTimer)
    }
    if (this.mowerDockedAtMs == null || !this.control) {
      return
    }
    const remaining = MOWER_DOCK_STALE_JOB_MS - (Date.now() - this.mowerDockedAtMs)
    const delay = Math.max(0, remaining)
    this.staleDockEndTimer = setTimeout(() => {
      this.endStaleMowerJob('docked-over-1h')
    }, delay)
  }

  /** End a mid-job that has sat on the dock too long (app End). */
  private endStaleMowerJob(reason: string): void {
    if (!this.isLawnMower || !this.control) {
      return
    }
    // Timer may fire after she already left — never End while mowing.
    if (this.currentOperationalState !== 65 && this.currentOperationalState !== 66) {
      this.logDebug(`skipping stale dock End (${reason}) — no longer on dock (state=${this.currentOperationalState})`)
      this.clearMowerDockTracking()
      return
    }
    if (!this.hasOpenJob && !isOpenMowerJob(this.lastCleanReport)) {
      this.clearMowerDockTracking()
      return
    }
    this.logInfo(`GOAT mid-job stale on dock — sending stop / End (${reason})`)
    runMowerCleanAction(this.control, 'stop')
    this.hasOpenJob = false
    this.lastCleanReport = 'idle'
    this.clearMowerDockTracking()
  }

  /** Maps Ecovacs ChargeState values to Matter rvcOperationalState. */
  private async onChargeState(newVal: string): Promise<void> {
    if (!newVal) {
      this.logDebug('ChargeState received with empty value, ignoring')
      return
    }
    this.logInfo(`${platformLang.receiveCmd} [ChargeState: ${newVal}]`)
    switch (newVal.toLowerCase()) {
      case 'returning':
        if (this.isLawnMower) {
          this.hasOpenJob = true
        }
        await this.updateRunMode(0) // Idle
        await this.updateOperationalState(64) // SeekingCharger
        break
      case 'charging':
        // Still on the contacts while leaving after start — keep Running.
        if (this.isLawnMower && this.currentOperationalState === 1) {
          this.logDebug('ignoring ChargeState charging while GOAT is Running')
          break
        }
        // Mid-job on dock: note arrival / schedule stale End — do not stop now.
        this.noteMowerDockArrival('charging')
        if (this.isLawnMower) {
          await this.updateRunMode(0) // Idle
        }
        await this.updateOperationalState(65) // Charging
        break
      case 'docked':
        // Synthetic from onChargeInfo (GOAT MQTT patch). Always means on dock,
        // including when a mid-job is still paused/resumable.
        this.noteMowerDockArrival('chargeInfo')
        if (this.isLawnMower) {
          await this.updateRunMode(0) // Idle
        }
        await this.updateOperationalState(66) // Docked
        break
      case 'idle':
        // Charge "idle" means not charging. While mowing/paused on the lawn
        // that is normal — ignore (must not look like docked). Check CleanReport
        // as well as operationalState: pause and ChargeState idle often arrive
        // in the same burst, and the Matter awaits have not updated state yet.
        if (this.isLawnMower && (
          this.currentOperationalState === 1
          || this.currentOperationalState === 2
          || isPausedCleanReport(this.lastCleanReport)
          || CLEANING_STATES.has(this.lastCleanReport)
        )) {
          this.logInfo(
            `ignoring ChargeState idle while GOAT clean=${this.lastCleanReport || '?'} `
            + `operationalState=${this.currentOperationalState}`,
          )
          break
        }
        this.noteMowerDockArrival('docked')
        if (this.isLawnMower) {
          await this.updateRunMode(0) // Idle
        }
        await this.updateOperationalState(66) // Docked
        break
      default:
        this.logDebug(`unrecognised ChargeState: ${newVal}`)
    }
  }

  private async onBatteryInfo(newVal: number): Promise<void> {
    if (newVal == null || newVal < 0 || newVal > 100) {
      this.logDebug(`BatteryInfo received with invalid value: ${newVal}`)
      return
    }
    if (this.lastLoggedBattery !== newVal) {
      this.lastLoggedBattery = newVal
      this.logInfo(`${platformLang.receiveCmd} [BatteryInfo: ${newVal}%]`)
    }
    // batPercentRemaining uses half-percent units (0-200)
    const batPercentRemaining = newVal * 2
    // batChargeLevel: 0 = OK, 1 = Warning, 2 = Critical
    const batChargeLevel = newVal <= 10 ? 2 : newVal <= 20 ? 1 : 0
    await this.updateState('powerSource', {
      status: 1, // active
      batPercentRemaining,
      batChargeLevel,
    })
  }

  /** Maps Ecovacs CleanSpeed to Matter rvcCleanMode. */
  private async onCleanSpeed(newVal: number): Promise<void> {
    if (this.lastLoggedCleanSpeed !== newVal) {
      this.lastLoggedCleanSpeed = newVal
      this.logInfo(`${platformLang.receiveCmd} [CleanSpeed: ${newVal}]`)
    }
    // Speed 3 or 4 → Max Clean (mode 3); else → Vacuum (mode 0)
    const cleanMode = [3, 4].includes(newVal) ? 3 : 0
    await this.updateState('rvcCleanMode', { currentMode: cleanMode })
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Matter handlers: Matter → Ecovacs commands
  // ──────────────────────────────────────────────────────────────────────────

  private async handleChangeRunMode(request: MatterRequests.ChangeToMode): Promise<void> {
    this.logInfo(`rvcRunMode.changeToMode → ${request.newMode}`)
    if (!this.isDeviceReady()) {
      return
    }
    switch (request.newMode) {
      case 0: // Idle → go home (End happens when ChargeState hits the dock)
        this.control.run('Charge')
        break
      case 1: // Cleaning → start auto clean
      case 2: // Mapping (not all devices support this – send auto clean as fallback)
        if (this.isLawnMower) {
          const onDock = this.currentOperationalState === 65
            || this.currentOperationalState === 66
          // Paused (2) / running mid-job / CleanReport open → job in progress.
          const hasOpenJob = this.hasOpenJob
            || this.currentOperationalState === 2
            || isOpenMowerJob(this.lastCleanReport)
          const decision = resolveMowerPlayAction({
            hasOpenJob,
            onDock,
            dockedAtMs: this.mowerDockedAtMs,
          })
          this.logInfo(
            `GOAT play → ${decision.endFirst ? 'stop+' : ''}${decision.action}`
            + ` (onDock=${onDock}, openJob=${hasOpenJob})`,
          )
          if (decision.endFirst) {
            runMowerCleanAction(this.control, 'stop')
          }
          runMowerCleanAction(this.control, decision.action)
          this.hasOpenJob = true
          this.clearMowerDockTracking()
          await this.updateRunMode(1) // Cleaning
          await this.updateOperationalState(1) // Running
        } else {
          this.control.run(this.isV2 ? 'Clean_V2' : 'Clean')
        }
        break
      default:
        this.logWarn(`unsupported run mode: ${request.newMode}`)
    }
  }

  private async handleChangeCleanMode(request: MatterRequests.ChangeToMode): Promise<void> {
    this.logInfo(`rvcCleanMode.changeToMode → ${request.newMode}`)
    if (!this.isDeviceReady()) {
      return
    }
    switch (request.newMode) {
      case 0: // Vacuum (standard) → speed 2
        this.control.run('SetCleanSpeed', 2)
        break
      case 3: // Max Clean → speed 3
        this.control.run('SetCleanSpeed', 3)
        break
      default:
        this.logWarn(`unsupported clean mode: ${request.newMode}`)
    }
  }

  private async handlePause(): Promise<void> {
    this.logInfo('rvcOperationalState.pause')
    if (!this.isDeviceReady()) {
      return
    }
    if (this.isLawnMower) {
      runMowerCleanAction(this.control, 'pause')
      this.hasOpenJob = true
    } else {
      this.control.run('Pause')
    }
    // Match onCleanReport pause: Idle run mode so Home does not keep "Vacuuming".
    await this.updateRunMode(0) // Idle
    await this.updateOperationalState(2) // Paused
  }

  private async handleResume(): Promise<void> {
    this.logInfo('rvcOperationalState.resume')
    if (!this.isDeviceReady()) {
      return
    }
    if (this.isLawnMower) {
      runMowerCleanAction(this.control, 'resume')
      this.hasOpenJob = true
      this.clearMowerDockTracking()
    } else {
      this.control.run('Resume')
    }
    await this.updateRunMode(1) // Cleaning
    await this.updateOperationalState(1) // Running
  }

  private async handleGoHome(): Promise<void> {
    this.logInfo('rvcOperationalState.goHome')
    if (!this.isDeviceReady()) {
      return
    }
    if (this.isLawnMower && this.currentOperationalState === 1) {
      this.hasOpenJob = true
    }
    this.control.run('Charge')
    await this.updateRunMode(0) // Idle
    await this.updateOperationalState(64) // SeekingCharger
  }

  private async handleSelectAreas(request: MatterRequests.SelectAreas): Promise<void> {
    this.logInfo(`serviceArea.selectAreas → ${JSON.stringify(request.newAreas)}`)
    if (!this.isDeviceReady()) {
      return
    }

    // Empty array means clean everywhere (no area constraint)
    if (!request.newAreas || request.newAreas.length === 0) {
      this.logDebug('No areas selected — starting full auto clean.')
      this.control.run(this.isV2 ? 'Clean_V2' : 'Clean')
      await this.updateState('serviceArea', { selectedAreas: [] })
      await this.updateRunMode(1) // Cleaning
      await this.updateOperationalState(1) // Running
      return
    }

    // Validate that all requested areas are known
    const validAreas: number[] = []
    for (const areaId of request.newAreas) {
      if (this.areasById.has(areaId)) {
        validAreas.push(areaId)
      } else {
        this.logWarn(`selectAreas: unknown area ID ${areaId}, skipping`)
      }
    }

    if (validAreas.length === 0) {
      this.logWarn('selectAreas: no valid areas to clean')
      return
    }

    // Send SpotArea command with comma-separated area IDs
    const areaCommand = validAreas.join(',')
    this.logDebug(`Sending SpotArea command: ${areaCommand}`)
    if (this.isV2) {
      this.control.run('SpotArea_V2', areaCommand)
    } else {
      this.control.run('SpotArea', 'start', areaCommand)
    }

    await this.updateState('serviceArea', { selectedAreas: validAreas })
    await this.updateRunMode(1) // Cleaning
    await this.updateOperationalState(1) // Running
  }

  private async handleSkipArea(request: MatterRequests.SkipArea): Promise<void> {
    this.logInfo(`serviceArea.skipArea → area ${request.skippedArea}`)
    if (!this.isDeviceReady()) {
      return
    }

    if (!this.areasById.has(request.skippedArea)) {
      this.logWarn(`skipArea: unknown area ID ${request.skippedArea}`)
      return
    }

    // Read the current selected areas and remove the skipped one
    const currentState = await this.readState('serviceArea')
    const currentAreas: number[] = (currentState as any)?.selectedAreas ?? []
    const remaining = currentAreas.filter(id => id !== request.skippedArea)

    this.logDebug(`Skipping area ${request.skippedArea}, remaining: [${remaining.join(', ')}]`)
    await this.updateState('serviceArea', { selectedAreas: remaining })
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Public update helpers (callable from the platform for immediate sync)
  // ──────────────────────────────────────────────────────────────────────────

  public async updateOperationalState(state: number): Promise<void> {
    // Leaving the dock (or starting to mow) must clear the dock-stay clock and
    // cancel the 1h End timer — otherwise a later return reuses the old stamp.
    if (this.isLawnMower && state === 1) {
      this.clearMowerDockTracking()
    }
    this.currentOperationalState = state
    await this.updateState('rvcOperationalState', { operationalState: state })
  }

  public async updateRunMode(mode: number): Promise<void> {
    await this.updateState('rvcRunMode', { currentMode: mode })
  }

  /** Push the current map/area data into the Matter serviceArea cluster. */
  private async flushServiceAreas(): Promise<void> {
    const supportedMaps = Array.from(this.mapsById.entries(), ([mapId, name]) => ({ mapId, name }))
    const supportedAreas = Array.from(this.areasById.entries(), ([areaId, { mapId, name }]) => ({
      areaId,
      mapId: this.mapsById.size > 0 ? mapId : null,
      areaInfo: {
        locationInfo: { locationName: name },
      },
    }))
    await this.updateState('serviceArea', { supportedMaps, supportedAreas })
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────────────────

  /** Disconnect the underlying device control (called during plugin shutdown). */
  public disconnect(): void {
    if (this.control?.is_ready) {
      this.control.disconnect()
    }
  }

  private isDeviceReady(): boolean {
    if (!this.control) {
      this.logWarn('command ignored – device not yet connected')
      return false
    }
    if (!this.control.is_ready) {
      this.logWarn('command ignored – device not ready')
      return false
    }
    return true
  }
}
