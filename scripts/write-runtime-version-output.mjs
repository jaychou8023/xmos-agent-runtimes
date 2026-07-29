#!/usr/bin/env node

import { appendFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

function readArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key.startsWith('--') || !value || value.startsWith('--')) throw new Error('Usage: --runtime <aion-cli|hermes-lite|hermes-max> --github-output <path>')
    args[key.slice(2)] = value
    index += 1
  }
  return args
}

async function main() {
  const args = readArgs(process.argv.slice(2))
  if (!args.runtime || !args['github-output']) throw new Error('Missing --runtime or --github-output')
  const lock = JSON.parse(await readFile(resolve('runtimes/runtime-sources.lock.json'), 'utf8'))
  const version = {
    'aion-cli': lock.aionCli.artifactVersion,
    'hermes-lite': lock.hermes.artifactVersions?.lite,
    'hermes-max': lock.hermes.artifactVersions?.max,
  }[args.runtime]
  if (!version) throw new Error(`No artifact version is defined for ${args.runtime}`)
  await appendFile(resolve(args['github-output']), `value=${version}\n`, 'utf8')
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
