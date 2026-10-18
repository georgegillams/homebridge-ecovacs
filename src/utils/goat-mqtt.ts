/**
 * Ecovacs GOAT mowers push state on MQTT topics that `ecovacs-deebot` does not
 * handle. Without a rewrite those messages are logged as unknown and dropped,
 * so pause/resume from the Ecovacs app never reaches Homebridge.
 *
 * Observed by nord-/ha-ecovacs-mower (and confirmed against O1200 traffic):
 *   - `onScheduleTaskInfo` — same clean-info payload as `onCleanInfo`
 *     (`state` + `cleanState.motionState`). This is what app pause/resume and
 *     rain delays arrive on.
 *   - `onChargeInfo` — return/dock (`goCharging` / `idle`). `idle` here means
 *     on the dock, not "job ended"; routing it through CleanInfo would clear
 *     a resumable mid-job, so we emit a synthetic ChargeState instead.
 *
 * Also: GOAT answers `getCleanInfo` with `{state:"idle"}` every time, even
 * mid-run. Do not poll GetCleanState for mowers (see Matter refresh path).
 */

export interface GoatMqttRoute {
  /** Re-enter the library handler under this command name. */
  asCommand?: string
  /** Optional replacement payload for `asCommand`. */
  payload?: unknown
  /** Emit ChargeState with this value (library emitMessage). */
  emitChargeState?: string
}

/**
 * Strip the library's usual inbound prefixes so we can match GOAT topics.
 * Mirrors `getCommandPrefix` in ecovacsMQTT_JSON.js (on / off / report / get).
 */
export function goatMqttBaseCommand(command: string): string {
  let abbreviated = String(command || '').replace(/^_+|_+$/g, '')
  if (abbreviated.endsWith('_V2')) {
    abbreviated = abbreviated.slice(0, -3)
  }
  const lower = abbreviated.toLowerCase()
  if (lower.startsWith('on')) {
    return abbreviated.slice(2)
  }
  if (lower.startsWith('off')) {
    return abbreviated.slice(3)
  }
  if (lower.startsWith('report')) {
    return abbreviated.slice(6)
  }
  if (lower.startsWith('get')) {
    return abbreviated.slice(3)
  }
  return abbreviated
}

/**
 * Decide how a GOAT MQTT command should be handled.
 * Returns null when the message should pass through unchanged.
 */
export function routeGoatMqttCommand(
  command: string,
  payload: unknown,
): GoatMqttRoute | null {
  const base = goatMqttBaseCommand(command)
  if (base === 'ScheduleTaskInfo') {
    // Identical shape to onCleanInfo — let the library's CleanInfo path run.
    return { asCommand: 'onCleanInfo' }
  }
  if (base !== 'ChargeInfo') {
    return null
  }

  const data = payload && typeof payload === 'object'
    ? payload as Record<string, unknown>
    : {}

  if (data.trigger === 'alert') {
    return { asCommand: 'onCleanInfo', payload: data }
  }
  if (data.state === 'goCharging') {
    return { asCommand: 'onCleanInfo', payload: data }
  }
  if (data.state === 'idle') {
    // On the dock. Synthetic value so Matter/HAP can dock without treating
    // this like a polled ChargeState idle while paused on the lawn.
    return { emitChargeState: 'docked' }
  }
  return null
}

interface GoatMqttControl {
  ecovacs?: {
    handleMessagePayload?: (command: string, payload: unknown) => Promise<void> | void
    emitMessage?: (name: string, payload: unknown) => void
    __goatMqttPatched?: boolean
  }
}

export type GoatMqttRouteLogger = (message: string) => void

/**
 * Wrap the vacbot MQTT dispatcher so GOAT-only topics become CleanReport /
 * ChargeState events. Safe to call more than once.
 *
 * @returns true when the wrapper is in place (or already was)
 */
export function patchGoatMqttMessages(
  control: GoatMqttControl,
  onRoute?: GoatMqttRouteLogger,
): boolean {
  const mqtt = control?.ecovacs
  if (!mqtt || typeof mqtt.handleMessagePayload !== 'function') {
    return false
  }
  if (mqtt.__goatMqttPatched) {
    return true
  }

  const original = mqtt.handleMessagePayload.bind(mqtt)
  mqtt.handleMessagePayload = async (command: string, payload: unknown) => {
    const routed = routeGoatMqttCommand(command, payload)
    if (!routed) {
      return original(command, payload)
    }
    if (routed.asCommand) {
      onRoute?.(
        `receiving update [MQTT ${command} → ${routed.asCommand}: ${JSON.stringify(routed.payload ?? payload)}]`,
      )
      return original(routed.asCommand, routed.payload ?? payload)
    }
    if (routed.emitChargeState && typeof mqtt.emitMessage === 'function') {
      onRoute?.(
        `receiving update [MQTT ${command} → ChargeState: ${routed.emitChargeState}]`,
      )
      mqtt.emitMessage('ChargeState', routed.emitChargeState)
    }
  }
  mqtt.__goatMqttPatched = true
  return true
}
