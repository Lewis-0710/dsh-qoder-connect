const cp = require('node:child_process')
const origExec = cp.exec
cp.exec = function (cmd, ...args) {
  if (typeof cmd === 'string' && cmd.includes('net use')) {
    const cb = args.find(a => typeof a === 'function')
    if (cb) cb(null, '', '')
    return { on: () => {} }
  }
  return origExec.call(this, cmd, ...args)
}
