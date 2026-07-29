#!/usr/bin/env node

import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

function args(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || !value || value.startsWith('--')) throw new Error('Usage: --private-key <path> [--trust <path>] [--key-id <id>]')
    result[key.slice(2)] = value
    index += 1
  }
  return result
}

async function main() {
  const options = args(process.argv.slice(2))
  if (!options['private-key']) throw new Error('Missing --private-key')
  const trustPath = resolve(options.trust || 'runtimes/runtime-trust.json')
  const trust = JSON.parse(await readFile(trustPath, 'utf8'))
  const keyId = options['key-id'] || 'xmos-runtime-release-2026-07'
  const expected = trust.keys?.[keyId]
  if (!expected) throw new Error(`Unknown signing key ID: ${keyId}`)
  const privateKey = createPrivateKey(await readFile(resolve(options['private-key']), 'utf8'))
  const derived = createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }).toString()
  const expectedPublic = createPublicKey(expected).export({ format: 'pem', type: 'spki' }).toString()
  if (derived !== expectedPublic) throw new Error(`Private key does not match trusted publisher key: ${keyId}`)
  const challenge = Buffer.from('xmos-runtime-signing-key-verification/v1', 'utf8')
  const signature = sign(null, challenge, privateKey)
  if (!verify(null, challenge, expectedPublic, signature)) throw new Error('Ed25519 sign/verify self-test failed')
  process.stdout.write(`Verified trusted Runtime signing key: ${keyId}\n`)
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
