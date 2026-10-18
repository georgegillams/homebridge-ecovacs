import { describe, expect, it, vi } from 'vitest'

import {
  goatMqttBaseCommand,
  patchGoatMqttMessages,
  routeGoatMqttCommand,
} from './goat-mqtt.js'

describe('goatMqttBaseCommand', () => {
  it('strips on / get / report prefixes', () => {
    expect(goatMqttBaseCommand('onScheduleTaskInfo')).toBe('ScheduleTaskInfo')
    expect(goatMqttBaseCommand('onChargeInfo')).toBe('ChargeInfo')
    expect(goatMqttBaseCommand('getCleanInfo')).toBe('CleanInfo')
    expect(goatMqttBaseCommand('reportBattery')).toBe('Battery')
  })

  it('strips a trailing _V2', () => {
    expect(goatMqttBaseCommand('onCleanInfo_V2')).toBe('CleanInfo')
  })
})

describe('routeGoatMqttCommand', () => {
  it('rewrites ScheduleTaskInfo to CleanInfo (app pause/resume)', () => {
    expect(routeGoatMqttCommand('onScheduleTaskInfo', {
      state: 'clean',
      cleanState: { motionState: 'pause' },
    })).toEqual({ asCommand: 'onCleanInfo' })
  })

  it('rewrites ChargeInfo goCharging through CleanInfo', () => {
    const payload = { state: 'goCharging', trigger: 'app' }
    expect(routeGoatMqttCommand('onChargeInfo', payload)).toEqual({
      asCommand: 'onCleanInfo',
      payload,
    })
  })

  it('emits synthetic docked for ChargeInfo idle', () => {
    expect(routeGoatMqttCommand('onChargeInfo', { state: 'idle' })).toEqual({
      emitChargeState: 'docked',
    })
  })

  it('leaves unrelated commands alone', () => {
    expect(routeGoatMqttCommand('onBattery', { value: 80 })).toBeNull()
    expect(routeGoatMqttCommand('onCleanInfo', { state: 'clean' })).toBeNull()
  })
})

describe('patchGoatMqttMessages', () => {
  it('routes ScheduleTaskInfo into the CleanInfo handler', async () => {
    const original = vi.fn(async () => {})
    const onRoute = vi.fn()
    const control = {
      ecovacs: {
        handleMessagePayload: original,
        emitMessage: vi.fn(),
      },
    }

    expect(patchGoatMqttMessages(control, onRoute)).toBe(true)
    expect(patchGoatMqttMessages(control, onRoute)).toBe(true) // idempotent

    await control.ecovacs.handleMessagePayload!('onScheduleTaskInfo', {
      state: 'clean',
      cleanState: { motionState: 'working' },
    })
    expect(original).toHaveBeenCalledWith('onCleanInfo', {
      state: 'clean',
      cleanState: { motionState: 'working' },
    })
    expect(onRoute).toHaveBeenCalledOnce()
    expect(onRoute.mock.calls[0][0]).toContain('onScheduleTaskInfo')
  })

  it('emits ChargeState docked for ChargeInfo idle', async () => {
    const original = vi.fn(async () => {})
    const emitMessage = vi.fn()
    const onRoute = vi.fn()
    const control = {
      ecovacs: {
        handleMessagePayload: original,
        emitMessage,
      },
    }

    patchGoatMqttMessages(control, onRoute)
    await control.ecovacs.handleMessagePayload!('onChargeInfo', { state: 'idle' })
    expect(original).not.toHaveBeenCalled()
    expect(emitMessage).toHaveBeenCalledWith('ChargeState', 'docked')
    expect(onRoute.mock.calls[0][0]).toContain('ChargeState: docked')
  })

  it('returns false when the MQTT object is missing', () => {
    expect(patchGoatMqttMessages({})).toBe(false)
  })
})
