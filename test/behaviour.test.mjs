// Behaviour test for lib/index.js: run with
//   node --import ./test/register.mjs test/behaviour.test.mjs
// It reproduces the 0.2.0 regression (a session created under a foreign preset,
// then switched to 纯对话 before its first turn, kept losing keep_thinking) and
// pins the budget arithmetic.
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const TOOL = 'keep_thinking'

/** Fresh plugin instance plus the hooks its listeners use. */
function harness(config = {}) {
  const handlers = new Map()
  const tools = new Map()
  const warnings = []
  const ctx = {
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
      return () => {}
    },
    tools: {
      register(definition) { tools.set(definition.name, definition); return () => {} },
    },
  }
  apply(ctx, { maxRounds: 10, visibleInPresets: ['chat'], ...config })
  return {
    ctx,
    tools,
    warnings,
    emit: (name, ...args) => { for (const fn of handlers.get(name) ?? []) fn(...args) },
    definition: tools.get(TOOL),
  }
}

let sequence = 0
/** A fake agent whose preset comes from a frozen header plus logged selections. */
function agent(header, selections = [], { restrictThrows = false } = {}) {
  const id = `session-test-${sequence += 1}`
  const state = { restrictions: [], lifted: 0, log: [...selections] }
  return {
    id,
    session: {
      id,
      header: header === undefined ? {} : { agentPreset: header },
      ownEvents: () => state.log.map(p => ({
        type: 'agent-preset/selected',
        data: { agentPreset: p },
      })),
    },
    ctx: {
      tools: {
        restrict(filter) {
          if (restrictThrows) throw new Error('restrict refused')
          state.restrictions.push(filter)
          return () => { state.lifted += 1 }
        },
      },
    },
    state,
  }
}

/**
 * Mirror `Session.append()`: it pushes to the log BEFORE notifying
 * `session/event` (core/session/src/index.ts:761 then :764), and the registry
 * re-emits `agent-preset/selected` from that notification. The log therefore
 * already carries the new selection when the plugin's listener runs.
 */
function select(h, a, preset) {
  a.state.log.push(preset)
  h.emit('agent-preset/selected', a.session.id, preset)
}

const denied = a => a.state.restrictions.filter(r => r.deny?.includes(TOOL)).length

// ---------------------------------------------------------------- visibility

{
  const h = harness()
  const a = agent('standard')
  h.emit('agent/created', { agent: a })
  assert.equal(denied(a), 1, 'a foreign creation preset must deny the tool')
}

{
  const h = harness()
  const a = agent('cordis', ['chat'])
  h.emit('agent/created', { agent: a })
  assert.equal(denied(a), 0, 'the log selection, not the header, decides (resume path)')
}

{
  const h = harness()
  const a = agent('chat')
  h.emit('agent/created', { agent: a })
  assert.equal(denied(a), 0, 'the listed preset keeps the tool')
}

{
  const h = harness()
  const a = agent(undefined)
  h.emit('agent/created', { agent: a })
  assert.equal(denied(a), 0, 'an unnamed composition must never lose the tool')
}

{
  // The 0.2.0 regression: created as `standard`, switched to `chat` before the
  // first turn. The header stays `standard`, so only the lift path can save it.
  const h = harness()
  const a = agent('standard')
  h.emit('agent/created', { agent: a })
  assert.equal(denied(a), 1, 'precondition: the creation preset denied it')
  select(h, a, 'chat')
  assert.equal(a.state.lifted, 1, 'selecting a listed preset must lift the denial')
  assert.equal(denied(a), 1, 'and must not install a second restriction')
  select(h, a, 'chat')
  assert.equal(a.state.lifted, 1, 'repeating the selection is a no-op')
}

{
  const h = harness()
  const a = agent('chat')
  h.emit('agent/created', { agent: a })
  select(h, a, 'cordis')
  assert.equal(denied(a), 1, 'switching away from the listed preset denies it')
  assert.equal(a.state.lifted, 0, 'nothing to lift yet')
  select(h, a, 'chat')
  assert.equal(a.state.lifted, 1, 'switching back lifts it again')
}

{
  const h = harness()
  const other = agent('chat')
  h.emit('agent/created', { agent: other })
  h.emit('agent-preset/selected', 'session-not-registered', 'standard')
  assert.equal(denied(other), 0, 'an unknown session id touches nothing')
}

{
  // `agent/created` is serial: a throw would veto session creation, and the same
  // sync runs inside the preset switch's own emit. It must never propagate.
  const h = harness()
  const a = agent('standard', [], { restrictThrows: true })
  assert.doesNotThrow(() => h.emit('agent/created', { agent: a }))
  assert.equal(h.warnings.length, 1, 'the failure is reported through the logger')
  assert.match(h.warnings[0], /cannot hide keep_thinking in preset "standard"/)

  const broken = harness()
  broken.ctx.logger.warn = () => { throw new Error('logger down') }
  const b = agent('standard', [], { restrictThrows: true })
  assert.doesNotThrow(() => broken.emit('agent/created', { agent: b }),
    'a broken logger must not veto the lifecycle step either')
}

{
  const h = harness()
  const a = agent('cordis', ['chat', 'standard'])
  h.emit('agent/created', { agent: a })
  assert.equal(denied(a), 1, 'the last logged selection wins')
  select(h, a, 'chat')
  assert.equal(a.state.lifted, 1)
}

// -------------------------------------------------------------------- budget

{
  const h = harness()
  const a = agent('chat')
  h.emit('agent/created', { agent: a })
  let concluded = 0
  const exec = { agent: a, concludeTurn: () => { concluded += 1 } }
  const rounds = []
  for (let i = 0; i < 11; i += 1) rounds.push(h.definition.execute({}, exec).round)
  assert.deepEqual(rounds, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  assert.equal(concluded, 1, 'only the call past the bound concludes the turn')

  const render = round => h.definition.output.render({}, { round, limit: 10 })[0].text
  assert.equal(render(1), '继续。（1/10，还剩 9 轮）')
  assert.equal(render(9), '继续。（9/10，还剩 1 轮）')
  assert.match(render(10), /^已达思考上限（10 轮）/)
  assert.equal(render(11), '思考已达 10 轮上限，本次回答到此结束。')

  h.emit('session/event', a.session, { type: 'turn/start' })
  assert.equal(h.definition.execute({}, exec).round, 1, 'turn/start resets the budget')
  assert.equal(concluded, 1)
}

{
  const h = harness({ maxRounds: 3 })
  const a = agent('chat')
  h.emit('agent/created', { agent: a })
  let concluded = 0
  const exec = { agent: a, concludeTurn: () => { concluded += 1 } }
  assert.deepEqual([1, 2, 3, 4].map(() => h.definition.execute({}, exec).round), [1, 2, 3, 4])
  assert.equal(concluded, 1, 'the bound follows the configured maxRounds')
  assert.match(h.definition.output.render({}, { round: 3, limit: 3 })[0].text, /^已达思考上限（3 轮）/)
}

{
  const h = harness()
  assert.equal(h.definition.parameters.thought.required, true)
  assert.equal(h.definition.output.schema.additionalProperties, false)
  assert.match(h.definition.description, /每次回答最多 10 轮思考/)
  assert.equal(h.tools.size, 1)
}

{
  // An agentless call still counts, so the bound holds on the shared key.
  const h = harness()
  const exec = { concludeTurn: () => {} }
  assert.equal(h.definition.execute({}, exec).round, 1)
  assert.equal(h.definition.execute({}, exec).round, 2)
}

{
  // `agent/disposed` drops the counter, so a recreated agent starts over.
  const h = harness()
  const a = agent('chat')
  h.emit('agent/created', { agent: a })
  const exec = { agent: a, concludeTurn: () => {} }
  assert.equal(h.definition.execute({}, exec).round, 1)
  assert.equal(h.definition.execute({}, exec).round, 2)
  h.emit('agent/disposed', { agent: a })
  assert.equal(h.definition.execute({}, exec).round, 1, 'recreation resets the budget')
}

{
  const h = harness({ visibleInPresets: ['chat', 'focus'] })
  for (const [preset, want] of [['chat', 0], ['focus', 0], ['standard', 1], [undefined, 0]]) {
    const a = agent(preset)
    h.emit('agent/created', { agent: a })
    assert.equal(denied(a), want, `preset ${String(preset)}`)
  }
}

console.log('all assertions passed')
