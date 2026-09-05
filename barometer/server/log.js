const ts = () => new Date().toISOString().slice(11, 19)
module.exports = {
  info: (tag, ...a) => console.log(`${ts()} [${tag}]`, ...a),
  warn: (tag, ...a) => console.warn(`${ts()} [${tag}]`, ...a),
  error: (tag, ...a) => console.error(`${ts()} [${tag}]`, ...a)
}
