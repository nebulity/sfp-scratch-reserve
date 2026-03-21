# reserve scratch

GitHub Action that reserves a pooled Salesforce scratch org via `sfp`, exposes it as outputs, and automatically returns it to the pool in a post step.

## Motivation

- Auto adds release step on operation end (`post`).

## Development

- Install dependencies: `npm install`
- Format: `npm run format`
- Lint: `npm run lint`
- Test: `npm run test`
- Type-check only: `npm run typecheck`
- Build TypeScript: `npm run build`
- Run all CI checks locally: `npm run ci`

## Prerequisites

- `sf` CLI available in `PATH`
- `sfp` CLI available in `PATH`
- `GITHUB_OUTPUT` and `GITHUB_STATE` available (standard in GitHub Actions)

## Usage

```yaml
- name: Reserve Scratch Org
  uses: andrii-solokh/sfp-scratch-reserve@v1
  with:
    pool-tag: latdx-ci
    devhub-sfdx-auth-url: ${{ secrets.SFDX_AUTH_URL_LATDX_DH }}
    devhub-alias: devhub
    set-default-devhub: "true"
    scratch-alias: scratch
    set-default-target-org: "true"
```

## Inputs

- `pool-tag` (required): scratch org pool tag.
- `devhub-alias` (optional, default: `devhub`): alias for Dev Hub used by `sf`/`sfp` commands.
- `devhub-sfdx-auth-url` (optional): SFDX auth URL to authenticate Dev Hub if needed.
- `set-default-devhub` (optional, default: `false`): set authenticated Dev Hub as default.
- `scratch-alias` (optional, default: `scratch`): alias for reserved scratch org.
- `set-default-target-org` (optional, default: `true`): set reserved scratch org as default target org.
- `fetch-attempts` (optional, default: `30`): reservation retries.
- `fetch-retry-seconds` (optional, default: `60`): delay between retries.

## Outputs

- `scratch-username`: reserved scratch org username.
- `scratch-alias`: resulting alias/target-org value.

## Behavior

- Reserves by fetching from `sfp pool:fetch`.
- Marks allocation status to `Reserve`.
- In post step, marks allocation status to `Return`.

## Release Flow

- Pull requests and pushes to `main` run `.github/workflows/pr.yml`.
- Pushes to `main` trigger `.github/workflows/release-please.yml` to maintain release PRs and changelog updates.
