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
 * The row lives INSIDE the 纯对话 preset and is named by this package's bare name
 * (see `cordis.patch.yml`). Two consequences:
 *
 * - Resolution: a preset's rows are mounted against the declaring Loader's
 *   resolution base — measured as the PROFILE directory — so they take the
 *   ordinary profile-local package route. The 0.1.x "never started" predates
 *   this package appearing in the profile's `dependencies`; see the header of
 *   `cordis.patch.yml` for the source-level rule and the fallback.
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
  // `natural()` is an integer step of 1; `min(1)` rejects 0, which would make
  // the very first call exceed the bound and end the turn on the spot. An
  // invalid value fails config validation at load, not silently at run time.
  maxRounds: z.natural().min(1).default(10),
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
    '· thought 必须是本轮真正推进的内容，留空会被拒绝且不计入轮数。',
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
    execute(args, exec) {
      // `required: true` guarantees a string, but not a non-empty one, and the
      // DSL cannot express that constraint. A blank round would silently spend
      // the budget and hand the model no correction, so fail the call instead —
      // a thrown error becomes an `isError` tool result, and a rejected call
      // must not spend a round.
      if (typeof args.thought !== 'string' || args.thought.trim() === '') {
        throw new Error(
          'keep_thinking: `thought` must not be empty. Write the reasoning this '
          + 'round advances, or answer the user directly instead of calling the tool.',
        )
      }
      // Without an owning agent the call still counts, so the bound holds.
      const id = exec.agent?.session?.id ?? ''
      const round = (used.get(id) ?? 0) + 1
      used.set(id, round)
      if (round > maxRounds) exec.concludeTurn()
      return { round, limit: maxRounds }
    },
  }))
}
