# Runtime release process

## Version rule

Runtime releases use `<upstream-version>+xmos.<revision>`. A packaging-only rebuild increments `xmos.<revision>`; an upstream upgrade resets the revision to `xmos.1` after review.

`xmos.hermes` is the signed package and policy family. Hermes Lite and Hermes Max remain separate physical releases, under V1 and V2 respectively; their capabilities, data compatibility and supported platforms are validated independently.

## Upstream detection

The scheduled workflow only identifies candidate tags and opens a PR. It never publishes a Runtime because each new upstream version must have its dependency locks, checksums, licenses, SBOM and compatibility reviewed.

For Aion, the candidate is a SemVer tag. Hermes accepts the upstream's current date-form or SemVer tags, but package version mapping and `uv.lock` checksum refresh are explicit review requirements.

## Release gates

Before a release is tagged, verify all supported platforms against a clean offline target:

- source commit, lock files and third-party artifact checksums;
- native architecture and Linux GLIBC 2.28 maximum;
- complete payload/SBOM/license inventory;
- deterministic ZIP, `files.sha256` and Ed25519 signature;
- Runtime Host preview, install, Bridge health, session lifecycle, upgrade rollback and uninstall data retention.

CI produces unsigned and short-lived candidates only. The Ed25519 private key remains on a trusted release machine and is never stored in GitHub Actions, repository files or Runtime ZIPs.
