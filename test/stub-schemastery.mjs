// Stand-in for @deepseek-ai/schemastery. The behaviour test calls apply() with a
// plain config object, so the schema only has to load without throwing.
const node = () => {
  const self = {}
  self.default = () => self
  self.required = () => self
  self.volatile = () => self
  return self
}
export default { object: node, number: node, array: node, string: node, boolean: node }
