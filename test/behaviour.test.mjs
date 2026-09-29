// Behaviour test for lib/index.js: run with
//   node --import ./test/register.mjs test/behaviour.test.mjs
//
// The plugin is mounted inside the 纯对话 preset by cordis.patch.yml, so scope —
// not this module — decides who sees the tool. The test therefore pins two
// things: the round budget (the only logic left here) and the absence of any
// visibility logic (the module must never call tools.restrict()).
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const TOOL = 'keep_thinking'

/** Fresh plugin instance plus the hooks its listeners use. */
function harness(config = {}) {
  const handlers = new Map()
  const tools = new Map()
  const restrictions = []
  const ctx = {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
      return () => {}
    },
    tools: {
      register(definition) { tools.set(definition.name, definition); return () => {} },
      restrict(filter) { restrictions.push(filter); return () => {} },
    },
  }
  apply(ctx, { maxRounds: 10, ...config })
  return {
    tools,
    restrictions,
    listeners: [...handlers.keys()].sort(),
    emit: (name, ...args) => { for (const fn of handlers.get(name) ?? []) fn(...args) },
    definition: tools.get(TOOL),
  }
}

/** A fake session identity; the counter only needs `id`. */
const session = id => ({ id })

// ---------------------------------------------------------------- registration

{
  const h = harness()
  assert.equal(h.tools.size, 1, 'exactly one tool')
  assert.deepEqual([...h.tools.keys()], [TOOL])
}

{
  // Scope, not this module, keeps the tool out of other modes. A `restrict()`
  // call here would mean visibility logic crept back in.
  const h = harness()
  assert.deepEqual(h.restrictions, [], 'the plugin must not restrict any agent')
  assert.deepEqual(h.listeners, ['agent/disposed', 'session/event'],
    'only the budget listeners are registered — no agent/preset visibility listeners')
}

{
  const def = harness().definition
  assert.equal(def.name, TOOL)
  assert.equal(def.parameters.thought.required, true)
  assert.equal(def.output.schema.additionalProperties, false)
  assert.deepEqual(Object.keys(def.output.schema.properties).sort(), ['limit', 'round'])
  assert.match(def.description, /每次回答最多 10 轮思考/)
  assert.equal(typeof def.execute, 'function')
}

// -------------------------------------------------------------------- budget

{
  const h = harness()
  const a = session('s-1')
  let concluded = 0
  const exec = { agent: { session: a }, concludeTurn: () => { concluded += 1 } }

  const rounds = []
  for (let i = 0; i < 11; i += 1) rounds.push(h.definition.execute({}, exec).round)
  assert.deepEqual(rounds, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  assert.equal(concluded, 1, 'only the call past the bound concludes the turn')

  const render = round => h.definition.output.render({}, { round, limit: 10 })[0].text
  assert.equal(render(1), '继续。（1/10，还剩 9 轮）')
  assert.equal(render(9), '继续。（9/10，还剩 1 轮）')
  assert.match(render(10), /^已达思考上限（10 轮）/)
  assert.equal(render(11), '思考已达 10 轮上限，本次回答到此结束。')

  h.emit('session/event', a, { type: 'turn/start' })
  assert.equal(h.definition.execute({}, exec).round, 1, 'turn/start resets the budget')
  assert.equal(concluded, 1, 'the reset does not re-trigger the bound')
}

{
  const h = harness({ maxRounds: 3 })
  let concluded = 0
  const exec = { agent: { session: session('s-2') }, concludeTurn: () => { concluded += 1 } }
  assert.deepEqual([1, 2, 3, 4].map(() => h.definition.execute({}, exec).round), [1, 2, 3, 4])
  assert.equal(concluded, 1, 'the bound follows the configured maxRounds')
  assert.match(h.definition.output.render({}, { round: 3, limit: 3 })[0].text, /^已达思考上限（3 轮）/)
}

{
  // The budget is per session: one session's calls do not spend another's.
  const h = harness()
  const first = { agent: { session: session('a') }, concludeTurn: () => {} }
  const second = { agent: { session: session('b') }, concludeTurn: () => {} }
  assert.equal(h.definition.execute({}, first).round, 1)
  assert.equal(h.definition.execute({}, first).round, 2)
  assert.equal(h.definition.execute({}, second).round, 1, 'another session starts at 1')
  assert.equal(h.definition.execute({}, { concludeTurn: () => {} }).round, 1,
    'an agentless call has its own key')
}

{
  // `agent/disposed` drops the counter, so a recreated agent starts over.
  const h = harness()
  const s = session('s-3')
  const exec = { agent: { session: s }, concludeTurn: () => {} }
  assert.equal(h.definition.execute({}, exec).round, 1)
  assert.equal(h.definition.execute({}, exec).round, 2)
  h.emit('agent/disposed', { agent: { session: s } })
  assert.equal(h.definition.execute({}, exec).round, 1, 'recreation resets the budget')
}

{
  // A turn started for an unrelated session must not clear this one.
  const h = harness()
  const mine = session('mine')
  const exec = { agent: { session: mine }, concludeTurn: () => {} }
  h.definition.execute({}, exec)
  h.emit('session/event', session('other'), { type: 'turn/start' })
  assert.equal(h.definition.execute({}, exec).round, 2, 'another session keeps its own count')
  h.emit('session/event', mine, { type: 'turn/start' })
  assert.equal(h.definition.execute({}, exec).round, 1)
}

console.log('all assertions passed')
