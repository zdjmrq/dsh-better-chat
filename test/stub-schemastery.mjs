// Stand-in for @deepseek-ai/schemastery. The behaviour test calls apply() with a
// plain config object, so the schema only has to LOAD here — real validation
// happens in DSH, where the actual schemastery enforces `natural()`/`min()`.
//
// That is a real gap, not a shortcut: this machine cannot resolve
// `@deepseek-ai/*` outside the DSH process (plain Node reports
// ERR_MODULE_NOT_FOUND), so a test cannot import the real validator.
// See "本地自测" in README.md for the manual check that covers it.
const node = () => {
  const self = {}
  for (const method of ['default', 'required', 'volatile', 'min', 'max', 'step', 'role']) {
    self[method] = () => self
  }
  return self
}
export default { object: node, number: node, natural: node, array: node, string: node, boolean: node }
