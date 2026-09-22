/** Scheduling and catch-up orchestration for daily 10:00 (UTC+8) check-in. */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { QoderCheckInResult } from './qoder/transport/checkin.ts'
import { qoderPluginDataDir } from './paths.ts'

export interface VariantCheckInTarget {
  variantId: string
  /**
   * Claim today's benefit for this variant.
   *
   * The variant's own transport owns credential resolution, so this takes no
   * token: a missing or unusable credential surfaces as an `error` result
   * rather than a throw, which keeps one signed-out variant from stopping the
   * sweep for the other.
   */
  checkIn: (signal?: AbortSignal) => Promise<QoderCheckInResult>
  onClaimed?: () => void
}

export interface CheckInLogItem {
  id: string
  date: string
  timestamp: number
  status: 'claimed' | 'already-claimed' | 'no-campaign' | 'error'
  amount?: number | undefined
  campaignKey?: string | undefined
  message?: string | undefined
}

export interface CheckInRecord {
  lastDate: string
  lastAt: number
  status: 'claimed' | 'already-claimed' | 'no-campaign' | 'error'
  amount?: number | undefined
  message?: string | undefined
  logs?: CheckInLogItem[] | undefined
}

export interface CheckInStatusStore {
  read(variantId: string): CheckInRecord | undefined
  write(variantId: string, record: CheckInRecord): void
  clearLogs(variantId: string): void
}

export class JsonFileCheckInStore implements CheckInStatusStore {
  private readonly filePath: string

  constructor(filePath?: string) {
    this.filePath = filePath ?? join(qoderPluginDataDir(), 'checkin-status.json')
  }

  private readAll(): Record<string, CheckInRecord> {
    try {
      if (!existsSync(this.filePath)) return {}
      const raw = readFileSync(this.filePath, 'utf-8')
      return JSON.parse(raw) as Record<string, CheckInRecord>
    } catch {
      return {}
    }
  }

  read(variantId: string): CheckInRecord | undefined {
    return this.readAll()[variantId]
  }

  clearLogs(variantId: string): void {
    try {
      const all = this.readAll()
      if (all[variantId]) {
        all[variantId] = {
          ...all[variantId],
          logs: [],
        }
        mkdirSync(dirname(this.filePath), { recursive: true })
        writeFileSync(this.filePath, JSON.stringify(all, null, 2), 'utf-8')
      }
    } catch {
      // Best-effort persistence
    }
  }

  write(variantId: string, record: CheckInRecord): void {
    try {
      const all = this.readAll()
      const existing = all[variantId]
      const existingLogs = existing?.logs ?? []
      const newLog: CheckInLogItem = {
        id: `${record.lastDate}-${record.lastAt}`,
        date: record.lastDate,
        timestamp: record.lastAt,
        status: record.status,
        ...record.amount === undefined ? {} : { amount: record.amount },
        ...record.message === undefined ? {} : { message: record.message },
      }
      const updatedLogs = [newLog, ...existingLogs.filter(l => l.id !== newLog.id)].slice(0, 30)
      all[variantId] = {
        ...record,
        logs: updatedLogs,
      }
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(all, null, 2), 'utf-8')
    } catch {
      // Best-effort persistence
    }
  }
}

/**
 * Returns the current date in YYYY-MM-DD standardized on UTC+8 (Beijing Time).
 */
export function getUtc8DateString(nowMs: number = Date.now()): string {
  const d = new Date(nowMs)
  // Shift by timezone offset to UTC, then +8 hours (480 mins)
  const utc8 = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60_000)
  const y = utc8.getFullYear()
  const m = String(utc8.getMonth() + 1).padStart(2, '0')
  const day = String(utc8.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Calculates milliseconds until the next 10:00:05 AM in UTC+8.
 */
export function msUntilNext10amUtc8(nowMs: number = Date.now()): number {
  const d = new Date(nowMs)
  // Calculate current UTC+8 hour/minute/second
  const utc8Time = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60_000)
  const targetUtc8 = new Date(utc8Time.getTime())
  targetUtc8.setHours(10, 0, 5, 0)

  let diff = targetUtc8.getTime() - utc8Time.getTime()
  if (diff <= 0) {
    // 10:00:05 today has passed, schedule for tomorrow
    targetUtc8.setDate(targetUtc8.getDate() + 1)
    diff = targetUtc8.getTime() - utc8Time.getTime()
  }
  return diff
}

/**
 * Whether today's daily reset hour (10:00 UTC+8) has already passed.
 */
export function isPastDailyCheckInHour(nowMs: number = Date.now()): boolean {
  const d = new Date(nowMs)
  const utc8 = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60_000)
  return utc8.getHours() >= 10
}

/**
 * Checks whether catch-up is needed today:
 * Current time is past today's 10:00:00 AM (UTC+8) and today has not yet settled a check-in.
 */
export function shouldCatchUp(today: string, lastDate?: string, nowMs: number = Date.now()): boolean {
  if (lastDate === today) return false
  return isPastDailyCheckInHour(nowMs)
}

export interface CheckInSchedulerOptions {
  targets: VariantCheckInTarget[]
  isEnabled: (variantId: string) => boolean
  store?: CheckInStatusStore | undefined
  onResult?: ((result: QoderCheckInResult) => void) | undefined
  now?: (() => number) | undefined
}

export class CheckInScheduler {
  private readonly targets: VariantCheckInTarget[]
  private readonly isEnabled: (variantId: string) => boolean
  private readonly store: CheckInStatusStore
  private readonly onResult: ((result: QoderCheckInResult) => void) | undefined
  private readonly now: () => number
  private timer: NodeJS.Timeout | undefined
  private disposed = false

  constructor(options: CheckInSchedulerOptions) {
    this.targets = options.targets
    this.isEnabled = options.isEnabled
    this.store = options.store ?? new JsonFileCheckInStore()
    this.onResult = options.onResult
    this.now = options.now ?? Date.now
  }

  start(): void {
    if (this.disposed) return
    // Immediate catch-up evaluation on startup
    void this.sweepAll(true)
    this.armNextTimer()
  }

  /**
   * Re-run the startup catch-up once the toggles are actually readable.
   *
   * `start()` runs while the plugin is still assembling, before the settings
   * section that owns these toggles has handed over its stored values, so that
   * first sweep sees the raw plugin config and skips the day. The host calls
   * this again from the section's source callback; the sweep is idempotent, so
   * a day already handled costs nothing.
   */
  catchUp(): void {
    if (this.disposed) return
    void this.sweepAll(true)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private armNextTimer(): void {
    if (this.disposed) return
    const delay = msUntilNext10amUtc8(this.now())
    this.timer = setTimeout(() => {
      void this.sweepAll(false)
      this.armNextTimer()
    }, delay)
    this.timer.unref?.()
  }

  async sweepAll(isCatchUp: boolean): Promise<void> {
    if (this.disposed) return
    const nowMs = this.now()
    const today = getUtc8DateString(nowMs)

    for (const target of this.targets) {
      if (!this.isEnabled(target.variantId)) continue

      const record = this.store.read(target.variantId)
      // Only an actually claimed day is settled. A day whose attempt ended in
      // "no campaign" (the upstream had not released it yet) or in an error
      // must stay retryable, otherwise one early failure burns the whole day —
      // which is exactly what a wrong client identifier used to do.
      const settledToday = record?.lastDate === today
        && (record.status === 'claimed' || record.status === 'already-claimed')
      if (settledToday) continue
      // A catch-up run only makes sense once the daily reset hour has passed;
      // before it, the scheduled timer still owns today's attempt.
      if (isCatchUp && !isPastDailyCheckInHour(nowMs)) continue

      let result: QoderCheckInResult
      try {
        result = await target.checkIn()
      } catch {
        // A transport-level throw (no credential at all, a rejection) is not a
        // settled day: leave the record alone so a later sweep can retry.
        continue
      }
      try {
        if (result.status !== 'error') {
          this.store.write(target.variantId, {
            lastDate: result.date,
            lastAt: result.timestamp,
            status: result.status,
            amount: result.amount,
            message: result.message,
          })
          if (result.status === 'claimed') {
            target.onClaimed?.()
          }
        }
        this.onResult?.(result)
      } catch {
        // Ignored to protect loop
      }
    }
  }
}
