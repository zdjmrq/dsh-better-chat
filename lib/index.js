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
 * The row lives INSIDE the 纯对话 preset and is named by an absolute `file:` URL
 * (see `cordis.patch.yml`), not by this package's name. Two consequences:
 *
 * - Resolution: a preset's rows mount into a registry-owned in-memory Loader
 *   subtree, so a profile-local package name does not resolve there. An absolute
 *   URL skips package resolution entirely.
 * - Scope: `ctx.tools.register()` through a preset's context registers the tool
 *   in that preset's scope. Only agents composed from 纯对话 see it, and no
 *   other mode has to be masked back — which is why this module owns no
 *   visibility logic and never calls `tools.restrict()`.
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
})

/** Model-visible result text for one `keep_thinking` round. */
function renderRound(round, limit) {
  if (round > limit) return `思考已达 ${limit} 轮上限，本次回答到此结束。`
  if (round === limit) {
    return `已达思考上限（${limit} 轮）。现在必须直接给出最终答案，不要再调用本工具。`
  }
  return `继续。（${round}/${limit}，还剩 ${limit - round} 轮）`
}

/**
 * Register the `keep_thinking` tool and its per-turn round counter.
 * @param ctx - owning plugin context; the tool registry is injected.
 * @param config - validated plugin config carrying `maxRounds`.
 */
export function apply(ctx, config) {
  const maxRounds = config.maxRounds
  const used = new Map()

  // One budget per user turn: a new turn starts the count over.
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') used.delete(session.id)
  })
  ctx.on('agent/disposed', ({ agent }) => { used.delete(agent.session.id) })

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
