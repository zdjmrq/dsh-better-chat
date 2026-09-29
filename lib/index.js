/**
 * keep_thinking — a text-only control-flow tool that lets the model ask for
 * another round of reasoning.
 *
 * It carries no side effect and touches no capability: calling it means "I am
 * not done thinking", not calling it ends the turn. The agent loop turns each
 * call into one more step, so the model decides both the number of rounds and
 * when to stop. `maxRounds` bounds that decision; the round past the bound
 * concludes the turn so the loop cannot run away.
 *
 * The row registers at the profile layer, which is global — a profile-local
 * package name cannot resolve from inside a preset's mounted subtree
 * (`resolver.ts` hands it to Node only when `layer.kind === 'profile'`, and
 * `collectProfileScopePackages` removes each bundle's own name from the shared
 * table). So the tool is visible to every preset's agents unless it is taken
 * away per agent, which `visibleInPresets` does through `tools.restrict()`.
 *
 * Which preset an agent runs is NOT `session.header.agentPreset`. The header is
 * a frozen creation fact; a blank session may still select a different preset
 * before its first turn, and that selection lands in the log as
 * `agent-preset/selected` (`agent-preset-registry/src/session.ts`: "reads the
 * agentPreset Session projection, never the header alone"). Both halves of that
 * window matter: `session-controller/src/commands.ts` creates the agent with the
 * session, so `agent/created` has already run and denied the tool from the
 * header, and only then does `select()` recompose `agent.ctx` and append. A
 * decision taken once in `agent/created` would therefore keep denying the tool
 * to a session that has become 纯对话. This plugin re-derives the preset on
 * every selection, and lifts the denial through the `restrict()` disposer. The
 * order makes that safe to read: `Session.append()` pushes the event into the
 * log and only then notifies `session/event` (core/session/src/index.ts), and
 * the registry re-emits `agent-preset/selected` from that notification, so
 * `ownEvents()` already reports the new selection when the listener runs.
 *
 * @module think_better
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'think_better'
export const inject = ['tools']

/** The single wire name this plugin owns. */
const TOOL_NAME = 'keep_thinking'

/** Plugin config, validated by schemastery before `apply` runs. */
export const Config = z.object({
  maxRounds: z.number().default(10),
  /** Agent preset ids that keep the tool; every other preset's agents deny it. */
  visibleInPresets: z.array(z.string()).default(['chat']),
})

/**
 * The preset a session currently runs: the creation header, advanced by every
 * committed `agent-preset/selected`.
 * @param session - the agent's durable session.
 * @returns the current preset id, or null when the deployment names none.
 */
function currentPreset(session) {
  let preset = session.header.agentPreset ?? null
  for (const event of session.ownEvents()) {
    if (event.type !== 'agent-preset/selected') continue
    const next = event.data?.agentPreset
    if (typeof next === 'string') preset = next
  }
  return preset
}

/** Model-visible result text for one `keep_thinking` round. */
function renderRound(round, limit) {
  if (round > limit) return `思考已达 ${limit} 轮上限，本次回答到此结束。`
  if (round === limit) {
    return `已达思考上限（${limit} 轮）。现在必须直接给出最终答案，不要再调用本工具。`
  }
  return `继续。（${round}/${limit}，还剩 ${limit - round} 轮）`
}

/**
 * Register the `keep_thinking` tool, its per-turn round counter, and the
 * per-agent visibility restriction.
 * @param ctx - owning plugin context; the tool registry is injected.
 * @param config - validated plugin config carrying `maxRounds` and `visibleInPresets`.
 */
export function apply(ctx, config) {
  const maxRounds = config.maxRounds
  const visibleInPresets = new Set(config.visibleInPresets)
  const used = new Map()
  const agents = new Map()
  const denials = new Map()

  // The tool is global, so every preset's agents would see it. `restrict()` is
  // the sanctioned way to remove a global tool from one agent scope: the
  // service refuses a context-global filter and names this exact pattern.
  const sync = (agent) => {
    let preset = null
    try {
      preset = currentPreset(agent.session)
      // Only a positively identified foreign preset is denied. An unnamed preset
      // must never hide the tool from the composition that left it unnamed.
      const keep = preset === null || visibleInPresets.has(preset)
      const denial = denials.get(agent)
      if (keep) {
        if (denial !== undefined) {
          // Drop the handle only once the disposer returned, so a throw leaves
          // the record in place for the next sync to retry.
          denial()
          denials.delete(agent)
        }
        return
      }
      if (denial !== undefined) return
      denials.set(agent, agent.ctx.tools.restrict({ deny: [TOOL_NAME] }))
    } catch (error) {
      // `agent/created` is serial: a throw here vetoes agent creation. This also
      // runs inside the preset switch's own event emission, where a throw would
      // surface as a failed switch. Losing the restriction is survivable;
      // losing the session or the switch is not.
      try {
        ctx.logger.warn(`think_better: cannot hide ${TOOL_NAME} in preset "${String(preset)}": ${String(error)}`)
      } catch { /* the logger is best effort: it must never veto a lifecycle step */ }
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    agents.set(agent.session.id, agent)
    sync(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    denials.delete(agent)
    agents.delete(agent.session.id)
    used.delete(agent.session.id)
  })
  // A blank session may select its preset after the agent exists, and the
  // committed selection is what later turns run under.
  ctx.on('agent-preset/selected', (sessionId) => {
    const agent = agents.get(sessionId)
    if (agent !== undefined) sync(agent)
  })

  // One budget per user turn: a new turn starts the count over.
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') used.delete(session.id)
  })

  const description = [
    '当你判断当前推演还不充分、需要继续思考时调用本工具，把这一轮的思考写进 thought。',
    '如果你已经可以给出最终回答，就不要调用，直接回答。',
    '',
    `每次回答最多 ${maxRounds} 轮思考。每次调用会返回已用轮数与剩余轮数。`,
    `· ${maxRounds} 轮是防止无限循环的安全上限。简单问题直接回答。`,
    '· 不要为了用满预算而无意义调用；结论可靠就作答。',
    `· 用满 ${maxRounds} 轮后仍调用本工具，本次回答会被强制结束。`,
  ].join('\n')

  ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description,
    parameters: {
      thought: {
        type: 'string',
        required: true,
        description: '这一轮要推进的思考内容。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          round: { type: 'number', required: true },
          limit: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderRound(value.round, value.limit),
      }],
    },
    execute(_args, exec) {
      // Without an owning agent the call still counts, so the bound holds.
      const id = exec.agent?.session?.id ?? ''
      const round = (used.get(id) ?? 0) + 1
      used.set(id, round)
      if (round > maxRounds) exec.concludeTurn()
      return { round, limit: maxRounds }
    },
  }))
}
