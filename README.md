# LotsTeam Connector

Connect a local machine or VPS to LotsTeam coding agents.

This package lets a machine with a repo checkout run Codex or Claude Code for tasks assigned in LotsTeam.

## Install / Run

One-time interactive setup:

```bash
npx @lotstech/lotsteam-connector create
```

Keep the machine connected:

```bash
npx @lotstech/lotsteam-connector start
```

Process one queued task and stop:

```bash
npx @lotstech/lotsteam-connector once
```

Check configuration:

```bash
npx @lotstech/lotsteam-connector status
```

## What Users Need

- Node.js 20+
- Git
- Codex CLI or Claude Code CLI installed and signed in
- A LotsTeam machine token from Team > AI Teammate setup
- A local or VPS folder containing the repo

## Config Location

The connector stores config here:

```text
~/.lotsteam-connector/config.json
```

Example:

```json
{
  "baseUrl": "https://team.example.com",
  "token": "ltcr_...",
  "repoMap": {
    "lots.team": "/Users/me/Projects/lots.team"
  },
  "pollIntervalMs": 10000
}
```

## Environment Overrides

```bash
LOTSTEAM_BASE_URL=https://team.example.com \
LOTSTEAM_RUNNER_TOKEN=ltcr_xxx \
LOTSTEAM_REPO_MAP='{"lots.team":"/Users/me/Projects/lots.team"}' \
npx @lotstech/lotsteam-connector start
```

Quiet logging is the default. The connector prints run start/finish and a 30 second heartbeat, but does not print the full Codex or Claude transcript to PM2 logs. For debugging, enable verbose logs:

```bash
LOTSTEAM_CONNECTOR_VERBOSE=1 npx @lotstech/lotsteam-connector start
```

Captured transcript tails are bounded to 256 KB by default. Override only when debugging:

```bash
LOTSTEAM_TRANSCRIPT_LIMIT_BYTES=524288 npx @lotstech/lotsteam-connector start
```

By default, the connector runs coding agents in unattended automation mode so tasks do not stop for approval:

- Codex uses full-access mode.
- Claude Code uses `--permission-mode bypassPermissions`.

Use the connector only on a trusted machine, VM, or VPS. To choose stricter modes:

```bash
LOTSTEAM_CODEX_BYPASS_SANDBOX=0 LOTSTEAM_CODEX_SANDBOX=workspace-write \
LOTSTEAM_CLAUDE_PERMISSION_MODE=acceptEdits npx @lotstech/lotsteam-connector start
```

## Publish Steps

1. Log in to npm:

```bash
npm login
```

2. Make sure the `@lotstech` npm organization exists and your npm user has publish access.

3. Dry-run package contents:

```bash
npm pack --dry-run
```

4. Publish public scoped package:

```bash
npm publish --access public
```

5. Test from a clean folder:

```bash
npx @lotstech/lotsteam-connector status
```

## Release Updates

For future versions:

```bash
npm version patch
npm publish --access public
```

Use `minor` for new features and `major` for breaking changes.
