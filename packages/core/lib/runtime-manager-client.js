import { constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, closeSync } from 'node:fs'
import { connect } from 'node:net'
import path from 'node:path'

const MAX_FRAME_BYTES = 128 * 1024
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

function validateId(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`${label} is invalid`)
  return value
}

function validateSocketPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('..') || /[\0\r\n]/u.test(value)) throw new Error('runtime manager socket path is invalid')
  return value
}

function readCapabilityTokenFile(filePath) {
  if (!path.posix.isAbsolute(filePath) || filePath.includes('..') || /[\0\r\n]/u.test(filePath)) throw new Error('runtime manager capability token file path is invalid')
  const info = lstatSync(filePath)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('runtime manager capability token file must be a regular non-symlink file')
  if ((info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('runtime manager capability token file must be owner-only')
  const parent = lstatSync(path.dirname(filePath))
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) !== 0 || (typeof process.getuid === 'function' && parent.uid !== process.getuid())) throw new Error('runtime manager capability token parent must be owner-only')
  const fd = openSync(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  let token
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || (opened.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && opened.uid !== process.getuid()) || opened.ino !== info.ino || opened.dev !== info.dev) throw new Error('runtime manager capability token changed while opening')
    token = readFileSync(fd, 'utf8').trim()
    const after = fstatSync(fd)
    if (after.ino !== opened.ino || after.dev !== opened.dev || after.size !== opened.size || (after.mode & 0o077) !== 0) throw new Error('runtime manager capability token changed while reading')
  } finally { closeSync(fd) }
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) throw new Error('runtime manager capability token is invalid')
  return token
}

export class UnixSocketRuntimeManager {
  constructor({ socketPath, hostId, sourceHostId, sourceSessionId, capabilityToken, capabilityTokenFile, timeoutMs = 10_000 } = {}) {
    this.socketPath = validateSocketPath(socketPath)
    this.hostId = validateId(hostId, 'runtime manager hostId')
    this.sourceHostId = validateId(sourceHostId, 'runtime manager sourceHostId')
    this.sourceSessionId = validateId(sourceSessionId, 'runtime manager sourceSessionId')
    this.capabilityToken = typeof capabilityToken === 'string' ? capabilityToken : typeof capabilityTokenFile === 'string' ? readCapabilityTokenFile(capabilityTokenFile) : null
    if (typeof this.capabilityToken !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/u.test(this.capabilityToken)) throw new Error('runtime manager capability token is required')
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('runtime manager timeout is invalid')
    this.timeoutMs = timeoutMs
    this.queue = Promise.resolve()
    this.nextId = 1
  }

  async inspect(requirements = []) {
    const response = await this.#request({ type: 'runtime-manager.inspect', requirements })
    if (response.type !== 'runtime-manager.inspect.result' || !Array.isArray(response.states)) throw new Error('runtime manager inspect response is invalid')
    return response.states
  }

  async resolveExecutable(requirement, { targetSessionId } = {}) {
    validateId(targetSessionId, 'runtime manager targetSessionId')
    const response = await this.#request({ type: 'runtime-manager.resolve', requirement, targetSessionId })
    if (response.type !== 'runtime-manager.resolve.result' || response.targetSessionId !== targetSessionId || typeof response.result?.executable !== 'string' || !response.result.executable.startsWith('/')) throw new Error('runtime manager resolve response is invalid')
    return response.result
  }

  async ensure() {
    const error = new Error('runtime installation must be completed by Remote Project Desired State sync')
    error.code = 'RUNTIME_MANAGER_SYNC_REQUIRED'
    throw error
  }

  async authChallenge() {
    const error = new Error('runtime authentication challenge must be initiated by the Remote Host connector')
    error.code = 'RUNTIME_MANAGER_AUTH_REMOTE_ONLY'
    throw error
  }

  #request(message) {
    const run = this.queue.then(() => new Promise((resolve, reject) => {
      const id = `runtime-${this.nextId++}`
      const socket = connect(this.socketPath)
      let buffer = ''
      let settled = false
      const finish = (error, response) => {
        if (settled) return
        settled = true
        socket.destroy()
        if (error) reject(error); else resolve(response)
      }
      const timer = setTimeout(() => finish(Object.assign(new Error('runtime manager socket request timed out'), { code: 'RUNTIME_MANAGER_TIMEOUT' })), this.timeoutMs)
      socket.setEncoding('utf8')
      socket.on('connect', () => socket.write(`${JSON.stringify({ id, hostId: this.hostId, targetHostId: this.hostId, sourceHostId: this.sourceHostId, sourceSessionId: this.sourceSessionId, capabilityToken: this.capabilityToken, message })}\n`))
      socket.on('data', (chunk) => {
        buffer += chunk
        if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) { clearTimeout(timer); finish(Object.assign(new Error('runtime manager response exceeded frame limit'), { code: 'RUNTIME_MANAGER_FRAME_TOO_LARGE' })); return }
        const index = buffer.indexOf('\n')
        if (index < 0) return
        const line = buffer.slice(0, index)
        clearTimeout(timer)
        try {
          const frame = JSON.parse(line)
          if (frame.id !== id) throw new Error('runtime manager response id mismatch')
          if (frame.error) { const error = new Error(frame.error.message ?? 'runtime manager rejected request'); error.code = frame.error.code ?? 'RUNTIME_MANAGER_ERROR'; finish(error); return }
          finish(null, frame.response)
        } catch (error) { finish(error) }
      })
      socket.on('error', (error) => { clearTimeout(timer); const wrapped = new Error(`runtime manager socket unavailable: ${error.message}`); wrapped.code = 'RUNTIME_MANAGER_UNAVAILABLE'; finish(wrapped) })
      socket.on('close', () => { clearTimeout(timer); if (!settled) { const error = new Error('runtime manager socket closed before a response'); error.code = 'RUNTIME_MANAGER_UNAVAILABLE'; finish(error) } })
    }))
    this.queue = run.catch(() => undefined)
    return run
  }
}
