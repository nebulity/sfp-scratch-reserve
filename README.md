# reserve scratch

GitHub Action that atomically reserves a pooled Salesforce scratch org and automatically returns it to the pool in a post step.

## Motivation

- Atomic reservation: claims an `Available` `ScratchOrgInfo` using Salesforce REST `If-Unmodified-Since`, so concurrent jobs cannot allocate the same org.
- Auto-releases the scratch org in a `post` step when the job finishes.

## How the atomic claim works

1. Query Dev Hub for up to 10 `Available` / `Active` scratch orgs in the target pool, including `LastModifiedDate`.
2. Shuffle the candidates to reduce head-of-list contention with peer jobs.
3. `PATCH` each candidate with `If-Unmodified-Since: <LastModifiedDate>` and `Allocation_status__c = 'Allocate'`.
   - `204 No Content` means the claim succeeded atomically.
   - `412 Precondition Failed` means another worker got there first; try the next candidate.
4. On success, authenticate into the won scratch org via its `SfdxAuthUrl__c`.

Salesforce serializes writes per row and compares `If-Unmodified-Since` against the row's current `LastModifiedDate` under lock, so only one concurrent writer can succeed.

## Prerequisites

- `sf` CLI available in `PATH`.
- Dev Hub is already authorized (the action calls `sf org display --verbose --json` to read its access token).
- `GITHUB_OUTPUT` and `GITHUB_STATE` available (standard in GitHub Actions).

## Usage

```yaml
- name: Reserve Scratch Org
  uses: nebulity/sfp-scratch-reserve@v1
  with:
    pool-tag: ci
    devhub-alias: devhub
```

## Inputs

- `pool-tag` (required): scratch org pool tag (matches `Pooltag__c`).
- `devhub-alias` (optional, default: `""`): alias or username of the authenticated Dev Hub.
- `scratch-alias` (optional, default: `scratch`): alias to assign to the reserved scratch org.
- `set-default-target-org` (optional, default: `true`): set the reserved scratch org as the default target org.
- `fetch-attempts` (optional, default: `1`): number of re-query attempts if no candidate could be claimed (60s delay between attempts).

## Outputs

- `scratch-username`: reserved scratch org username.
- `scratch-alias`: alias assigned to the reserved scratch org (falls back to the username if no alias was supplied).

## Behavior

- Main step: atomic REST claim, then `sf org login sfdx-url` into the won org.
- Post step: returns the scratch org by setting `Allocation_status__c = 'Available'` via `sf data update record`.

## Development

- Install dependencies: `npm install`
- Format: `npm run format`
- Lint: `npm run lint`
- Test: `npm run test`
- Type-check only: `npm run typecheck`
- Build TypeScript: `npm run build`
- Run all CI checks locally: `npm run ci`

## Release Flow

- Pull requests and pushes to `main` run `.github/workflows/pr.yml`.
- Pushes to `main` trigger `.github/workflows/release-please.yml` to maintain release PRs and changelog updates. The release workflow also moves the floating `v<major>` and `v0` tags to the new release.
