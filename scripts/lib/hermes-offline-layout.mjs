export const HERMES_RUNTIME_CAPABILITIES = Object.freeze([
  'chat.sessions',
  'chat.history',
  'chat.streaming',
  'chat.cancel',
  'reasoning',
  'tools',
  'approval',
  'clarification',
  'secrets',
  'model.catalog',
  'model.credentials',
  'skills',
  'mcp',
  'cron',
  'channels',
  'channels.matrix',
  'subagents',
  'memory',
  'dashboard',
  'gateway',
  'acp',
  'voice',
  'video',
])

export const HERMES_LITE_RUNTIME_CAPABILITIES = Object.freeze([
  'chat.sessions',
  'chat.history',
  'chat.streaming',
  'chat.cancel',
  'model.catalog',
  'model.credentials',
])

export function hermesEditionPayloadProfile(edition = 'max') {
  if (edition === 'lite') {
    return Object.freeze({
      capabilities: HERMES_LITE_RUNTIME_CAPABILITIES,
      includeBrowserArchive: false,
      includeManagedNode: false,
      includeManagedTools: false,
      includeOptionalAssets: false,
      includeVoiceModel: false,
      useAllExtras: false,
    })
  }

  if (edition === 'max') {
    return Object.freeze({
      capabilities: HERMES_RUNTIME_CAPABILITIES,
      includeBrowserArchive: true,
      includeManagedNode: true,
      includeManagedTools: true,
      includeOptionalAssets: true,
      includeVoiceModel: true,
      useAllExtras: true,
    })
  }

  throw new Error(`Unsupported Hermes edition: ${edition}`)
}

export function hermesEditionArtifactVersion(hermes, edition = 'max') {
  const version = hermes?.artifactVersions?.[edition]
  if (typeof version === 'string' && version.length > 0) return version
  throw new Error(`Hermes source lock is missing the signed ${edition} artifact version`)
}

export function assertHermesEditionPayloadLayout({ edition, files, provenance }) {
  const profile = hermesEditionPayloadProfile(edition)
  if (provenance?.edition !== edition) {
    throw new Error(`Hermes payload provenance edition mismatch: expected ${edition}`)
  }
  if (!Array.isArray(files)) throw new Error('Hermes payload file inventory is required')

  const hasManagedPath = path => files.some(file => file === path || file.startsWith(`${path}/`))
  if (!profile.includeBrowserArchive && hasManagedPath('managed-resources/browser')) {
    throw new Error('Lite payload must not contain managed browser assets')
  }
  if (!profile.includeManagedNode && hasManagedPath('managed-resources/node')) {
    throw new Error('Lite payload must not contain managed Node assets')
  }
  if (!profile.includeManagedTools && hasManagedPath('managed-resources/tools')) {
    throw new Error('Lite payload must not contain managed tool assets')
  }
  if (!profile.includeVoiceModel && hasManagedPath('managed-resources/models')) {
    throw new Error('Lite payload must not contain managed voice-model assets')
  }
  if (!profile.includeOptionalAssets && (hasManagedPath('hermes-assets/optional-skills') || hasManagedPath('hermes-assets/optional-mcps'))) {
    throw new Error('Lite payload must not contain optional Hermes assets')
  }

  if (profile.includeBrowserArchive) {
    const archive = provenance?.managedAssets?.browser?.archive
    if (typeof archive !== 'string' || !files.includes(archive) || hasManagedPath('managed-resources/browser/chromium')) {
      throw new Error('Max browser asset must be a signed Chromium archive')
    }
  }
}

// Compatibility exports for older callers. A complete XMOS Hermes
// distribution never removes an upstream Python tool or plugin surface.
export const HERMES_RETAINED_PLUGIN_SURFACES = Object.freeze(['*'])
export const HERMES_REMOVED_TOOL_MODULES = Object.freeze([])

export const HERMES_ALLOWED_BUILD_REMOVALS = Object.freeze([
  '__pycache__',
  'build-intermediates',
  'bytecode-cache',
  'tests',
])

export const HERMES_EXCLUDED_DESKTOP_SHELLS = Object.freeze([
  'apps/desktop',
  'apps/bootstrap-installer',
])

export function isAllowedHermesPluginPath() {
  return true
}

export function hermesCapabilityCatalog(platform, edition = 'max') {
  return hermesEditionPayloadProfile(edition).capabilities.map(id => {
    const platformSupported = !(id === 'channels.matrix' && platform !== 'linux-x64')
    const configured = [
      'chat.sessions', 'chat.history', 'chat.streaming', 'chat.cancel',
      'reasoning', 'tools', 'approval', 'clarification', 'skills', 'mcp',
      'subagents', 'memory',
    ].includes(id)
    const surface = ['dashboard', 'voice', 'video'].includes(id)
      ? 'product'
      : ['gateway', 'channels', 'cron', 'acp'].includes(id)
        ? 'service'
        : ['tools', 'skills', 'mcp', 'subagents', 'memory'].includes(id)
          ? 'tool'
          : 'chat'
    return {
      configured,
      dependencyReady: platformSupported,
      enabled: platformSupported,
      id,
      included: true,
      platformSupported,
      ...(!platformSupported
        ? { reason: 'Upstream dependency is not supported on this platform' }
        : {}),
      surface,
    }
  })
}
