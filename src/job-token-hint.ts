/**
 * The conversation hint row for a self-healed job token.
 *
 * The card's status notice proved hard to observe, so the visible channel is
 * the session itself. The harness records a command line as a pair of
 * **log-only** session events — `command/run` + `command/done`, the mechanism
 * behind the `[icon] new · 已开启新会话。` row (and the same icon a pwsh tool
 * row uses). Appending that pair directly prints one line into the
 * conversation: no turn is opened, no model round trip happens, and **nothing
 * is registered** — so no synthetic command ever appears in the `/` menu:
 *
 *     [icon] qoder · jobToken 已自动刷新（旧令牌被上游拒绝，已自动重换并恢复）
 *
 * The host half alone produces this row; without a client renderer the title
 * is the recorded name, which is why it is the ASCII `qoder`.
 *
 * @module dsh-qoder-connect/job-token-hint
 */

import type { Context } from '@deepseek-ai/cordis'

/** The name recorded on the hint row (and therefore its displayed title). */
export const JOB_TOKEN_HINT_NAME = 'qoder'

/** The session slice this module appends to. */
interface HintSession {
  append(type: string, data: unknown): unknown
}

/** The agent slice this module needs: identity plus its session. */
interface HintAgent {
  readonly id: unknown
  readonly session?: HintSession
}

/** Refresh time per agent id, so a later read can name when it happened. */
const lastRefreshAt = new Map<string, number>()

/** The most recent agent observed entering a running turn. */
let lastRunningAgent: HintAgent | undefined

/** Monotonic suffix keeping appended ids unique within this process. */
let hintSeq = 0

/**
 * Start tracking which agent is running.
 *
 * `agent/status` is a plain `emit` event: a listener that returns nothing
 * cannot disturb the emitting path (unlike a waterfall event, where a listener
 * owes the chain its `next()` call). The self-heal fires inside that agent's
 * request, so the most recently running agent is the conversation to print
 * into.
 */
export function installJobTokenHint(ctx: Context): void {
  ctx.on('agent/status' as never, ((payload: { agent?: HintAgent, status?: string }) => {
    if (payload.status === 'running' && payload.agent !== undefined) {
      lastRunningAgent = payload.agent
    }
  }) as never)
}

/**
 * Print the refresh row into the conversation whose request triggered it.
 *
 * Best effort by design: a missing agent, an absent session, or a projection
 * that rejects the append must never affect the chat that just recovered.
 *
 * @param at - When the job token was rotated.
 * @param text - The row's summary line.
 */
export function emitJobTokenHint(at: number, text: string): void {
  const agent = lastRunningAgent
  if (agent?.session === undefined) return
  lastRefreshAt.set(String(agent.id), at)
  const commandId = `cmd-qoder-hint-${Date.now().toString(36)}-${++hintSeq}`
  try {
    // The official pairing: `command/run` opens the row, `command/done` carries
    // its summary. Both are log-only events, so no turn is opened and no
    // model-facing state changes.
    agent.session.append('command/run', {
      commandId,
      name: JOB_TOKEN_HINT_NAME,
      source: { kind: 'user' },
    })
    agent.session.append('command/done', {
      commandId,
      kind: 'success',
      text,
    })
  } catch {
    // The row reports a recovery that already happened; failing to print it is
    // diagnostics-grade and must never surface as a chat failure.
  }
}

/** The refresh time recorded for one agent, if this process rotated its token. */
export function jobTokenRefreshAt(agentId: unknown): number | undefined {
  return lastRefreshAt.get(String(agentId))
}
