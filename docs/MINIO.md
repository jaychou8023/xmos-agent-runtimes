# MinIO candidate-artifact storage

Runtime CI uploads only verified **unsigned candidates** to MinIO. A candidate is not loadable or formally released until it has been reviewed, signed on a trusted release machine and separately published.

## Configure GitHub repository secrets

Open the repository in GitHub, then go to **Settings → Secrets and variables → Actions → Secrets → New repository secret**. Create these four secrets:

| Secret | Value | Example |
|---|---|---|
| `MINIO_ENDPOINT` | S3-compatible API endpoint, including `https://`, without bucket name | `https://minio.example.com` |
| `MINIO_BUCKET` | Private target bucket name; do not include a slash or prefix | `xmos` |
| `MINIO_ACCESS_KEY` | A MinIO service-account access key with restricted write access | Do not place in source code |
| `MINIO_SECRET_KEY` | Corresponding secret key | Do not place in source code |

Do not put any of these values in `.env`, workflow YAML, Git history, pull-request text or Runtime ZIPs.

## Configure GitHub repository variables

Under **Settings → Secrets and variables → Actions → Variables**, add the following optional variables:

| Variable | Recommended value | Meaning |
|---|---|---|
| `MINIO_PREFIX` | `runtimes` | Bucket prefix for all Runtime artifacts inside the `xmos` bucket |
| `MINIO_INSECURE` | `false` | Set to `true` only when the endpoint is trusted and has a self-signed certificate |

The endpoint should use a valid HTTPS certificate. `MINIO_INSECURE=true` disables TLS certificate verification and is a temporary private-network exception, not a normal production setting.

## Object layout

The reusable candidate-upload workflow stores build outputs under:

```text
s3://<MINIO_BUCKET>/runtimes/candidates/<runtime>/<version>/<github-run-id>/<platform>/
```

For example:

```text
s3://xmos/runtimes/candidates/hermes-lite/0.18.2+xmos.3/123456789/darwin-arm64/
```

The later formal-release workflow will use a separate, stable location:

```text
s3://<MINIO_BUCKET>/runtimes/releases/<runtime>/<version>/
```

Do not overwrite a formal release object. Enable MinIO versioning and a lifecycle policy that expires unsigned `candidates/` objects after an appropriate review period, such as 30 days.

## Permission boundary

Create a dedicated MinIO service account for this repository. It needs only `s3:ListBucket`, `s3:GetObject` and `s3:PutObject` for the Runtime prefix; it does not need bucket administration, user management or deletion permission. Keep the bucket private and distribute signed Runtime ZIPs only through authenticated product download paths.

## How a Runtime build calls the reusable workflow

The candidate build workflow will upload only after it has generated and verified its GitHub artifact:

```yaml
upload-minio:
  needs: build
  uses: ./.github/workflows/_upload-runtime-candidate-to-minio.yml
  with:
    artifact-name: runtime-candidate-hermes-lite-darwin-arm64
    runtime: hermes-lite
    version: 0.18.2+xmos.3
    platform: darwin-arm64
  secrets: inherit
```

If the four secrets are not configured, the upload job finishes successfully but records a clear `MinIO upload skipped` message in the GitHub Actions summary. This allows build verification to be tested before storage credentials are configured.

## Trusted Mac release publishing

After candidate payloads are reviewed, publish formal signed Runtime ZIPs from the trusted Mac:

```bash
cd /Users/liyc/Documents/xmos-agent-runtimes
npm run runtime:release:publish -- \
  --runtime all \
  --run-id <github-run-id> \
  --endpoint https://s3.sgcc.zip \
  --bucket xmos \
  --prefix runtimes \
  --private-key ~/.xmos-signing/xmos-runtime-release-2026-07.pem
```

The script refuses `--secret-key` on the command line. Provide MinIO credentials through `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY`, or store the secret key in macOS Keychain using service `xmos-runtime-minio` and account `default`.

The script signs each verified candidate, uploads formal release objects, and writes:

```text
runtimes/metadata/catalog.json
runtimes/metadata/catalog-<timestamp>.json
```

XMOS 云中心只同步这个 signed release catalog；不要把 `candidates/` 当成客户端可下载目录。
