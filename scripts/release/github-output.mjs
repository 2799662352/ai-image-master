import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'

const OUTPUT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export function serializeGithubOutputs(
  values,
  createNonce = () => randomUUID(),
) {
  const blocks = []
  for (const [name, input] of Object.entries(values)) {
    if (!OUTPUT_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid GitHub output name: ${name}`)
    }
    const value = String(input ?? '').replace(/\r\n?/g, '\n')
    let delimiter
    do {
      delimiter = `ghadelimiter_${createNonce()}`
    } while (value.split('\n').includes(delimiter))
    blocks.push(`${name}<<${delimiter}\n${value}\n${delimiter}`)
  }
  return `${blocks.join('\n')}\n`
}

export function appendGithubOutputs(filePath, values) {
  if (!filePath) return
  appendFileSync(filePath, serializeGithubOutputs(values))
}
