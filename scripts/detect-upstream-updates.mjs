#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '..')
const sourceLockPath = resolve(repositoryRoot, 'runtimes/runtime-sources.lock.json')

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`)
    args[key.slice(2)] = value
    index += 1
  }
  return args
}

function runGit(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile('git', args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) rejectPromise(new Error(`git ${args.join(' ')} failed: ${stderr.trim() || error.message}`))
      else resolvePromise(stdout)
    })
  })
}

function tagVersion(tag) {
  const match = /^v?(\d+(?:\.\d+)+)$/.exec(tag)
  return match ? match[1].split('.').map(Number) : null
}

function compareTags(left, right) {
  const a = tagVersion(left)
  const b = tagVersion(right)
  if (!a || !b) return left.localeCompare(right)
  const max = Math.max(a.length, b.length)
  for (let index = 0; index < max; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return left.localeCompare(right)
}

async function latestTag(repository, accepted) {
  const raw = await runGit(['ls-remote', '--tags', repository])
  const entries = new Map()
  for (const line of raw.trim().split('\n')) {
    const [commit, ref] = line.split('\t')
    const match = /^refs\/tags\/(.+?)(\^\{\})?$/.exec(ref ?? '')
    if (!match || !accepted(match[1])) continue
    const tag = match[1]
    const current = entries.get(tag)
    entries.set(tag, match[2] ? { commit, peeled: true } : current ?? { commit, peeled: false })
  }
  const tag = [...entries.keys()].sort(compareTags).at(-1)
  if (!tag) throw new Error(`No accepted upstream tag found for ${repository}`)
  return { tag, commit: entries.get(tag).commit }
}

function makeCandidate({ repository, locked, latest, needsLockRefresh }) {
  return {
    repository,
    locked,
    latest: { ...latest, version: latest.tag.replace(/^v/, '') },
    updateAvailable: locked.commit !== latest.commit,
    requiresReview: true,
    needsLockRefresh,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const lock = JSON.parse(await readFile(sourceLockPath, 'utf8'))
  if (lock.schemaVersion !== 'xmos-runtime-sources/1') throw new Error('Unsupported runtime source lock schema')

  const [aion, hermes] = await Promise.all([
    latestTag(lock.aionCli.source.repository, tag => /^v?\d+\.\d+\.\d+$/.test(tag)),
    latestTag(lock.hermes.source.repository, tag => /^v?(?:\d+\.)+\d+$/.test(tag)),
  ])
  const report = {
    schemaVersion: 'xmos-runtime-upstream-candidates/1',
    candidates: {
      'aion-cli': makeCandidate({
        repository: lock.aionCli.source.repository,
        locked: { version: lock.aionCli.version, commit: lock.aionCli.source.commit },
        latest: aion,
        needsLockRefresh: ['source.commit', 'version', 'native binary checksums'],
      }),
      hermes: makeCandidate({
        repository: lock.hermes.source.repository,
        locked: { version: lock.hermes.version, commit: lock.hermes.source.commit },
        latest: hermes,
        needsLockRefresh: ['source.commit', 'version mapping', 'uv.lock checksum', 'package lock checksum', 'platform dependency checksums'],
      }),
    },
    note: 'A candidate is not an approved source lock or release. Review the upstream delta and rebuild all locked platform artifacts before updating runtime-sources.lock.json.',
  }

  if (args['write-candidates']) {
    const destination = resolve(repositoryRoot, args['write-candidates'])
    await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }
  process.stdout.write(`${JSON.stringify({ checkedAt: new Date().toISOString(), ...report }, null, 2)}\n`)
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
