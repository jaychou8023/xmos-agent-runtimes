#!/usr/bin/env node

import { appendFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

function readArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || !value || value.startsWith('--')) throw new Error('Usage: --runtime <hermes> --field <commit> --github-output <path>')
    args[key.slice(2)] = value
    index += 1
  }
  return args
}

async function main() {
  const args = readArgs(process.argv.slice(2))
  if (args.runtime !== 'hermes' || args.field !== 'commit' || !args['github-output']) {
    throw new Error('Only --runtime hermes --field commit is supported')
  }
  const lock = JSON.parse(await readFile(resolve('runtimes/runtime-sources.lock.json'), 'utf8'))
  const value = lock.hermes?.source?.commit
  if (!/^[a-f0-9]{40}$/i.test(value || '')) throw new Error('Hermes source commit is invalid')
  await appendFile(resolve(args['github-output']), `value=${value}\n`, 'utf8')
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
