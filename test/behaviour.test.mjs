// Behaviour test for lib/index.js: run with
//   node --import ./test/register.mjs test/behaviour.test.mjs
//
// The plugin is mounted inside the 更好的对话模式 preset by cordis.patch.yml, so
// scope — not this module — decides who sees the tool. The test therefore pins
// three things: the round budget, the absence of any visibility logic (the
// module must never call tools.restrict()), and that every registration it makes
// is disposable.
//
// Caveat the assertions below cannot cover: test/stub-loader.mjs replaces
// @deepseek-ai/schemastery and @deepseek-ai/dsh-tools with hand-written stubs,
// because plain Node cannot resolve `@deepseek-ai/*` on this machine. So the
// shape assertions on `definition` check the OBJECT THIS MODULE DECLARES, not
// what the real `defineTool` compiles it into — re-verify after any change to
// parameters/output by loading the bundle in DSH (see README "本地自测").
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const TOOL = 'keep_thinking'
/** A valid round payload; `thought` must be non-empty. */
const CALL = { thought: '检查一下这条推理的第二步。' }

/** Fresh plugin instance plus the hooks its listeners use. */
function harness(config = {}) {
  const handlers = new Map()
  const tools = new Map()
  const restrictions = []
  const disposers = []
  const ctx = {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
      const disposer = () => {
        const list = handlers.get(name) ?? []
        const at = list.indexOf(fn)
        if (at >= 0) list.splice(at, 1)
        if (list.length === 0) handlers.delete(name)
      }
      disposers.push(disposer)
      return disposer
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        const disposer = () => { tools.delete(definition.name) }
        disposers.push(disposer)
        return disposer
      },
      restrict(filter) { restrictions.push(filter); return () => {} },
    },
  }
  apply(ctx, { maxRounds: 10, ...config })
  return {
    tools,
    restrictions,
    // Reading `listeners` after `dispose()` is what proves teardown happened.
    get listeners() { return [...handlers.keys()].sort() },
    /** Run every disposer the plugin was handed, newest first. */
    dispose() { while (disposers.length > 0) disposers.pop()() },
    emit: (name, ...args) => { for (const fn of handlers.get(name) ?? []) fn(...args) },
    definition: tools.get(TOOL),
  }
}

/** A fake session identity; the counter only needs `id`. */
const session = id => ({ id })

/** An execution context for one session, recording turn conclusions. */
const execFor = (id, onConclude = () => {}) => ({
  agent: { session: session(id) },
  concludeTurn: onConclude,
})

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
  assert.match(def.description, /留空会被拒绝/)
  assert.equal(typeof def.execute, 'function')
}

// ------------------------------------------------------------ HMR safety (§15.2)

{
  // Every registration here is a registry contribution, so teardown has to be
  // observable: dispose the instance and assert nothing is left behind.
  const h = harness()
  assert.equal(h.tools.size, 1)
  assert.equal(h.listeners.length, 2)
  h.dispose()
  assert.equal(h.tools.size, 0, 'dispose unregisters the tool')
  assert.deepEqual(h.listeners, [], 'dispose removes both listeners')
  assert.doesNotThrow(() => h.dispose(), 'disposing twice is a no-op')
}

// -------------------------------------------------------------------- budget

{
  const h = harness()
  let concluded = 0
  const exec = execFor('s-1', () => { concluded += 1 })

  const rounds = []
  for (let i = 0; i < 11; i += 1) rounds.push(h.definition.execute(CALL, exec).round)
  assert.deepEqual(rounds, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  assert.equal(concluded, 1, 'only the call past the bound concludes the turn')

  const render = round => h.definition.output.render({}, { round, limit: 10 })[0].text
  assert.equal(render(1), '继续。（1/10，还剩 9 轮）')
  assert.equal(render(9), '继续。（9/10，还剩 1 轮）')
  assert.match(render(10), /^已达思考上限（10 轮）/)
  assert.equal(render(11), '思考已达 10 轮上限，本次回答到此结束。')

  h.emit('session/event', session('s-1'), { type: 'turn/start' })
  assert.equal(h.definition.execute(CALL, exec).round, 1, 'turn/start resets the budget')
  assert.equal(concluded, 1, 'the reset does not re-trigger the bound')
}

{
  const h = harness({ maxRounds: 3 })
  let concluded = 0
  const exec = execFor('s-2', () => { concluded += 1 })
  assert.deepEqual([1, 2, 3, 4].map(() => h.definition.execute(CALL, exec).round), [1, 2, 3, 4])
  assert.equal(concluded, 1, 'the bound follows the configured maxRounds')
  assert.match(h.definition.output.render({}, { round: 3, limit: 3 })[0].text, /^已达思考上限（3 轮）/)
}

// ------------------------------------------------------- the empty `thought` guard

{
  // `required: true` guarantees a string but not a non-empty one, and the value
  // DSL cannot express it. A rejected call must not spend a round.
  const h = harness()
  const exec = execFor('s-blank')
  assert.throws(() => h.definition.execute({ thought: '' }, exec), /must not be empty/)
  assert.throws(() => h.definition.execute({ thought: '   ' }, exec), /must not be empty/)
  assert.throws(() => h.definition.execute({}, exec), /must not be empty/)
  assert.throws(() => h.definition.execute({ thought: 42 }, exec), /must not be empty/)
  assert.equal(h.definition.execute(CALL, exec).round, 1, 'a rejected call spends nothing')
  assert.equal(h.definition.execute(CALL, exec).round, 2, 'accepted calls still count')
}

// --------------------------------------------------------- per-session isolation

{
  // The budget is per session: one session's calls do not spend another's.
  const h = harness()
  const first = execFor('a')
  const second = execFor('b')
  assert.equal(h.definition.execute(CALL, first).round, 1)
  assert.equal(h.definition.execute(CALL, first).round, 2)
  assert.equal(h.definition.execute(CALL, second).round, 1, 'another session starts at 1')
  assert.equal(h.definition.execute(CALL, { concludeTurn: () => {} }).round, 1,
    'an agentless call has its own key')
}

{
  // `agent/disposed` drops the counter, so a recreated agent starts over.
  const h = harness()
  const s = session('s-3')
  const exec = { agent: { session: s }, concludeTurn: () => {} }
  assert.equal(h.definition.execute(CALL, exec).round, 1)
  assert.equal(h.definition.execute(CALL, exec).round, 2)
  h.emit('agent/disposed', { agent: { session: s } })
  assert.equal(h.definition.execute(CALL, exec).round, 1, 'recreation resets the budget')
}

{
  // A turn started for an unrelated session must not clear this one.
  const h = harness()
  const mine = session('mine')
  const exec = { agent: { session: mine }, concludeTurn: () => {} }
  h.definition.execute(CALL, exec)
  h.emit('session/event', session('other'), { type: 'turn/start' })
  assert.equal(h.definition.execute(CALL, exec).round, 2, 'another session keeps its own count')
  h.emit('session/event', mine, { type: 'turn/start' })
  assert.equal(h.definition.execute(CALL, exec).round, 1)
}

console.log('all assertions passed')
