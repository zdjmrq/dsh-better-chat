// Redirect the two harness imports to local stubs so lib/index.js runs under
// plain Node, with the same file the bundle loads.
const STUBS = {
  '@deepseek-ai/schemastery': new URL('./stub-schemastery.mjs', import.meta.url).href,
  '@deepseek-ai/dsh-tools': new URL('./stub-dsh-tools.mjs', import.meta.url).href,
}

/** @param specifier - requested module. */
export function resolve(specifier, context, next) {
  const stub = STUBS[specifier]
  return stub === undefined ? next(specifier, context) : { url: stub, shortCircuit: true }
}
