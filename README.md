# XMOS Agent Runtimes

This repository manages the source locks, reproducible builds, verification evidence and releases for XMOS Agent Runtime ZIP packages.

## Scope

- Aion CLI (`xmos.aion-cli`)
- Hermes Lite (`xmos.hermes`, V1 package generation)
- Hermes Max (`xmos.hermes`, V2 package generation)
- Offline payload provenance, SBOMs, licenses, hashes and signed ZIP releases

The XMOS desktop application's Host Bridges, permission system, credentials, session routing and audit implementation stay in the desktop repository. A Runtime ZIP must never contain dynamic XMOS adapter or hook code.

## Automation model

1. A scheduled Action checks upstream Aion and Hermes tags.
2. A detected tag creates a review PR under `automation/upstream-*`.
3. After review, native runners build unsigned candidate payloads and run verification.
4. Verified unsigned candidates are mirrored automatically to the private MinIO candidate path.
5. A trusted release machine signs the ZIPs with Ed25519.
6. The signed ZIPs, SHA-256 sums, SBOM and generated release notes are uploaded to a GitHub Release and the formal MinIO release path.

See [docs/RELEASE_PROCESS.md](docs/RELEASE_PROCESS.md) for the release gate, and [docs/MINIO.md](docs/MINIO.md) for object-storage configuration.
