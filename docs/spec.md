# stress — Gatling Load Test Runner for EKS

## Overview

A standalone CLI tool (`stress`) distributed as a compiled binary via GitHub
releases. Automates running Gatling load tests on EKS, replacing a manual
multi-terminal workflow (aws-vault, kubectl, helm, log tailing) with a single
`stress --mode=run --image-tag=<tag>` invocation. Project-specific values come
from `stress.yaml` (or a custom path via `--config`).

Built with Deno and `@david/dax`. Compiled to a standalone binary via
`deno compile`.

## User Journey

```bash
# 1. Install (one time)
$ curl -L https://github.com/rnaudi/stress/releases/latest/download/stress-darwin-arm64 -o /usr/local/bin/stress && chmod +x /usr/local/bin/stress

# 2. Go to project
$ cd my-load-test-project

# 3. See what's available
$ stress
  (shows help with all flags)

# 4. Generate config
$ stress --init
  Created stress.yaml — edit it with your project values.

# 5. Edit config
$ vim stress.yaml

# 6. Check everything
$ stress --doctor
  [PASS] aws-vault: 7.2.0
  [PASS] kubectl: v1.28.2
  [PASS] helm: v3.14.0
  [PASS] stress.yaml: valid (cluster=analytics, namespace=load-test)
  [PASS] values: values.yaml exists
  [INFO] AWS credentials: not in env (will prompt via aws-vault)

# 7. Run
$ stress --mode=run --image-tag=abc123
```

## File Structure

```
stress/
├── .github/
│   └── workflows/
│       └── release.yml        # GitHub Actions: verify, compile, release
├── README.md              # user-facing documentation
├── deno.json              # imports @david/dax + @std/cli + @std/yaml, defines test task
├── stress.ts              # executable entry point, all logic in one file
├── stress_test.ts         # tests for pure/async logic functions
├── stress.yaml            # project-specific config (gitignored)
├── values.yaml            # helm values (gitignored)
├── values.example.yaml    # sanitized template (committed)
├── .gitignore             # ignores stress.yaml and values.yaml
├── deno.lock
└── docs/
    └── spec.md            # this file — engineering internals
```

## Dependencies

`deno.json`:

```json
{
  "imports": {
    "@david/dax": "jsr:@david/dax@^0.45.0",
    "@std/cli": "jsr:@std/cli@^1",
    "@std/yaml": "jsr:@std/yaml@^1",
    "@std/assert": "jsr:@std/assert@^1"
  },
  "tasks": {
    "test": "deno test --allow-read",
    "compile": "deno compile --allow-run --allow-env --allow-read --allow-write --target aarch64-apple-darwin --output stress-darwin-arm64 stress.ts"
  }
}
```

## CLI

### Usage

```
Usage: stress [options]

Modes:
  --mode=run --image-tag=<tag>   Run load test
  --mode=status                  Show pod status
  --mode=logs                    Stream runner logs

Options:
  --config=<path>   Config file (default: stress.yaml)
  --dry-run         Show commands without executing (mode=run only)

Setup:
  --init            Generate config from template
  --doctor          Check prerequisites and config
  --help            Show this help
```

### Types

```ts
type CLI = CLIHelp | CLIInit | CLIDoctor | CLIRun | CLIStatus | CLILogs;

type CLIHelp = { readonly tag: "help" };
type CLIInit = { readonly tag: "init"; readonly config: string };
type CLIDoctor = { readonly tag: "doctor"; readonly config: string };
type CLIRun = {
  readonly tag: "run";
  readonly config: string;
  readonly imageTag: string;
  readonly dryRun: boolean;
};
type CLIStatus = { readonly tag: "status"; readonly config: string };
type CLILogs = { readonly tag: "logs"; readonly config: string };
```

### Arguments

| Flag          | Type      | Required                    | Description                        |
| ------------- | --------- | --------------------------- | ---------------------------------- |
| `--mode`      | `string`  | For run/status/logs         | `"run"`, `"status"`, or `"logs"`   |
| `--image-tag` | `string`  | When `mode=run`             | Gatling Docker image tag           |
| `--dry-run`   | `boolean` | No (default: `false`)       | Helm `--dry-run`, skip pod monitor |
| `--config`    | `string`  | No (default: `stress.yaml`) | Path to config file                |
| `--init`      | `boolean` | No                          | Generate config from template      |
| `--doctor`    | `boolean` | No                          | Check prerequisites and config     |
| `--help`      | `boolean` | No                          | Show help                          |

### Parsing

`CLIParse(args: string[]): CLI` — parses CLI arguments using
`@std/cli/parse-args` into a tagged union. Short-circuit priority:

1. `--help` or no args → `{ tag: "help" }`
2. `--init` → `{ tag: "init", config }`
3. `--doctor` → `{ tag: "doctor", config }`
4. `--mode` required → exhaustive switch for `"run"`, `"status"`, `"logs"`

### Dispatch (`main()`)

Short-circuit order in `main()`:

1. Parse args → CLI tagged union (exit 1 on error)
2. If `help` → print USAGE, exit 0
3. If `init` → write template to config path, exit
4. If `doctor` → run all checks, exit 0/1
5. Load config from file (`--config` path or default `stress.yaml`)
6. Set up SIGINT handler
7. `execute(cli, cfg)` — exhaustive switch on `cli.tag`: run/status/logs

## Configuration

Project-specific values are loaded from `stress.yaml` (or custom path via
`--config`):

```yaml
# Where to run
profile: analytics-dev
cluster: analytics
region: us-east-1
namespace: load-test

# What to run
release: heimdall-load-test
chart: playgami-load-testing/load-test
values: values.yaml
simulation: com.scopely.heimdall.loadtest.smoke.SmokeSimulation
```

### Config interface

```ts
interface Config {
  readonly profile: string;
  readonly cluster: string;
  readonly region: string;
  readonly namespace: string;
  readonly release: string;
  readonly chart: string;
  readonly values: string;
  readonly simulation: string;
}
```

All 8 fields are required strings. `parseConfig(raw: unknown): Config` validates
raw parsed YAML and reports all missing/empty fields at once.

### Embedded templates

Both config and helm values templates are embedded in the binary as string
constants (`CONFIG_TEMPLATE`, `VALUES_TEMPLATE`). `--init` writes both to disk.
`values.example.yaml` is also committed as a reference.

## Constants

Values that stay in code (not config):

| Constant                 | Value                                                                      |
| ------------------------ | -------------------------------------------------------------------------- |
| `POLL_INTERVAL`          | `5_000` (ms) — tuning knob for pod polling                                 |
| `DEFAULT_CONFIG`         | `"stress.yaml"` — default config path                                      |
| `DEFAULT_VALUES`         | `"values.yaml"` — default values path                                      |
| `CONFIG_TEMPLATE`        | Embedded config YAML template (written by `--init`)                        |
| `VALUES_TEMPLATE`        | Embedded helm values YAML template (written by `--init`)                   |
| `REQUIRED_AWS_VARS`      | `["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]`      |
| `SENSITIVE_AWS_VARS`     | `Set(REQUIRED_AWS_VARS)` — values redacted in output                       |
| `REQUIRED_CONFIG_FIELDS` | All 8 Config field names — used for validation                             |
| `NOT_READY_STATUSES`     | `Set(["Pending", "ContainerCreating", "PodInitializing"])` — pod readiness |
| `USAGE`                  | Multiline help text                                                        |

### Gatling System Architecture

The helm chart creates a `Gatling` custom resource (API:
`gatling-operator.tech.zozo.com/v1alpha1`). The **Gatling Operator** running in
the cluster watches that CR and creates:

1. **Runner Job** (`<release>-runner`) — runs Gatling load test pods
2. **Reporter Job** (`<release>-reporter`) — generates HTML report, uploads to
   S3

## Setup Commands

### `--init` — Generate Config

`runInit(cli: CLIInit): Promise<void>`

Writes both `stress.yaml` (from `CONFIG_TEMPLATE`) and `values.yaml` (from
`VALUES_TEMPLATE`) to disk. Checks all files first -- refuses if either already
exists (exit 1 with message, nothing written).

### `--doctor` — Check Prerequisites

`runDoctor(cli: CLIDoctor): Promise<void>`

Runs all checks, exits 0 if everything passes, 1 if any required check fails:

1. **Tool checks** (parallel) — `aws-vault --version`,
   `kubectl version --client`, `helm version --short`. Prints `[PASS]` with
   version or `[FAIL]` with install hint.
2. **Config file** — loads and validates `stress.yaml` (or `--config` path).
   Prints `[PASS]` with cluster/namespace summary or `[FAIL]` with error.
3. **Values file** — checks the values file referenced in config exists on disk.
4. **AWS credentials** — informational only (`[INFO]`), not a failure. Reports
   found/partial/none status.

## Mode: run — Pipeline

The `runPipeline(cli: CLIRun, cfg: Config)` function runs sequential steps. If
any step fails the process aborts (except helm uninstall which tolerates
"release not found").

### Step 1 — AWS Vault Auth

**Function**: `getAwsEnv(cfg: Config): Promise<Record<string, string>>`

Before launching `aws-vault`, checks the current environment for existing AWS
credentials using `detectAwsEnv()`. This handles the common case where the
developer is already inside an `aws-vault` shell.

#### Detection flow

```
getAwsEnv(cfg)
  │
  ├─ detectAwsEnv(Deno.env.toObject())
  │   │
  │   ├─ "found"   → all 3 required vars present
  │   │              OK found N AWS env vars in current environment
  │   │              print each var with redacted values
  │   │              return env (skip aws-vault)
  │   │
  │   ├─ "partial" → some but not all required vars present
  │   │              Warning: partial AWS credentials in environment
  │   │              — found X but missing Y
  │   │              Falling back to aws-vault...
  │   │              (fall through)
  │   │
  │   └─ "none"    → no required vars present
  │                  No AWS credentials in environment, launching aws-vault...
  │                  (fall through)
  │
  └─ aws-vault exec <profile> --prompt=osascript -- env
     OK captured N AWS env vars via aws-vault
     print each var with redacted values
```

**Required AWS variables** (constant `REQUIRED_AWS_VARS`):

| Variable                | Purpose           |
| ----------------------- | ----------------- |
| `AWS_ACCESS_KEY_ID`     | IAM access key    |
| `AWS_SECRET_ACCESS_KEY` | IAM secret key    |
| `AWS_SESSION_TOKEN`     | STS session token |

**Redaction**: `redact(key, value)` — sensitive vars show first 4 chars + `****`
(or just `****` if value is 4 chars or fewer). Non-sensitive vars show full
value.

### Step 2 — EKS Kubeconfig

**Function**: `updateKubeconfig(awsEnv, cfg): Promise<void>`

```bash
aws eks update-kubeconfig --name <cluster> --region <region>
```

With `.env(awsEnv)` to use the credentials from step 1.

### Step 3 — Helm Uninstall

**Function**: `helmUninstall(awsEnv, cfg, dryRun): Promise<void>`

```bash
helm -n <namespace> uninstall <release> [--dry-run]
```

With `.env(awsEnv).noThrow()` — tolerates failure when no existing release.

### Step 4 — Helm Install

**Function**: `helmInstall(awsEnv, cfg, imageTag, dryRun): Promise<void>`

```bash
helm -n <namespace> install <release> <chart> \
  -f <values> \
  --set gatling.image.tag=<imageTag> \
  --set gatling.simulationClass=<simulation> \
  [--dry-run]
```

### Step 5 — Gatling Lifecycle Monitor

**Function**: `monitorGatling(awsEnv, cfg): Promise<void>`

Skipped entirely when `--dry-run` is set. Runs with no timeout — the user can
Ctrl+C at any time.

#### 5a — Background pod watch

Launches a background process as an unawaited promise with a separate
`watchAbort` AbortController:

```bash
kubectl get pod -n <namespace> -w
```

Streams pod status updates to stdout in real-time while Steps 5b-5c run. Killed
via `watchAbort.abort()` in a `finally` block after the lifecycle completes.

#### 5b — Wait for runners + stream runner logs

Polls every 5 seconds using plain text output (no JSON parsing):

```bash
kubectl get pods -n <namespace> -l job-name=<release>-runner --no-headers
```

Uses `parsePodStatus()` to extract the pod name and STATUS column, then
`isPodReady()` to determine if logs can be streamed. Only prints output when it
changes (state transitions), avoiding repetitive identical lines. Prints "no
pods yet" only once.

Once ready, streams runner logs:

```bash
kubectl logs -f -n <namespace> -l job-name=<release>-runner --all-containers --ignore-errors=true
```

#### 5c — Wait for reporter + stream reporter logs

Same pattern as 5b but with `job-name=<release>-reporter`.

## Mode: status

`runStatus(cli, cfg)` — runs Steps 1-2 (auth + kubeconfig), then prints current
pod status for both runner and reporter jobs.

## Mode: logs

`runLogs(cli, cfg)` — runs Steps 1-2 (auth + kubeconfig), then streams runner
logs.

## Dry Run Mode

When `--dry-run` is passed with `--mode=run`:

- **Steps 1, 2** run normally — they're read-only (auth, kubeconfig)
- **Step 3** (helm uninstall) appends `--dry-run` flag
- **Step 4** (helm install) appends `--dry-run` flag
- **Step 5** (Gatling lifecycle) is skipped entirely
- **Header** shows `[DRY RUN]` in the config banner

## Error Handling

- Each step logs a message before executing
- All dax commands throw on non-zero exit by default — script aborts on failure
- `helm uninstall` is the only command using `.noThrow()` (release may not
  exist)
- No timeout on test execution — runs until completion or Ctrl+C
- `CLIParse` throws with usage message on invalid/missing arguments
- `loadConfig` gives actionable errors: "not found — run stress --init" or lists
  all missing/empty fields at once

## Signal Handling / Graceful Shutdown

### Architecture

A single `AbortController` at module level serves as the cancellation primitive.
On `SIGINT` (Ctrl+C), the handler sets an `interrupted` flag, logs a warning,
and aborts the controller. All interruptible operations check the signal.

```
            AbortController (abort)
                  |
 Deno.addSignalListener("SIGINT")
                  |
            abort.abort()
                  |
     ┌────────────┼────────────┐
     │            │            │
waitForPods   streamLogs   podWatch
(pollUntil    (.signal()   (unawaited
 checks        on dax)      promise,
 .aborted,                  .signal() via
 interruptible              separate
 Sleep)                     watchAbort)
     │            │            │
     └────────────┼────────────┘
                  |
           finally block:
           watchAbort.abort() → await podWatch
           if interrupted → helmUninstall (no signal)
           main() exits with code 130
```

### Module-level state

```ts
const abort = new AbortController();
let interrupted = false;
```

### SIGINT handler

Registered in `main()` before `execute(cli, cfg)`:

```ts
Deno.addSignalListener("SIGINT", () => {
  interrupted = true;
  $.logWarn("\nInterrupted", "Ctrl+C received, cleaning up...");
  abort.abort();
});
```

### How functions are interrupted

| Function             | Mechanism                                                                         |
| -------------------- | --------------------------------------------------------------------------------- |
| `waitForPods`        | Uses `pollUntil(fn, POLL_INTERVAL, abort.signal)` internally                      |
| `streamLogs`         | Passes `abort.signal` to dax via `.signal(abort.signal)` (sends SIGTERM on abort) |
| `monitorGatling`     | Guards between steps with `if (abort.signal.aborted) return;` checks              |
| Background pod watch | Uses separate `watchAbort` controller, killed in `finally` block                  |

### Cleanup scope

- **Steps 1-4** (auth, kubeconfig, helm install/uninstall): No signal handling.
  If Ctrl+C during these steps, just exit. Next run always does `helm uninstall`
  first anyway.
- **Step 5** (monitoring): Full signal handling. On Ctrl+C: kill all running
  commands, clean up background watch, run `helm uninstall` to tear down the
  release.
- **`helmUninstall` during cleanup**: Fresh command without any signal attached
  (must complete).

### Exit code

Process exits with code **130** when interrupted (standard Unix convention for
SIGINT: `128 + 2`).

## Exported Functions

All exported functions are pure or async with no side effects (testable without
mocks, AWS credentials, or clusters).

| Function             | Type  | Description                                        |
| -------------------- | ----- | -------------------------------------------------- |
| `CLIParse`           | Pure  | Parses CLI args into tagged union                  |
| `parseConfig`        | Pure  | Validates raw YAML into Config                     |
| `parseAwsEnv`        | Pure  | Extracts AWS_* vars from env output                |
| `detectAwsEnv`       | Pure  | Detects AWS credential status in env               |
| `redact`             | Pure  | Redacts sensitive values for display               |
| `parsePodStatus`     | Pure  | Parses kubectl pod line into name + status         |
| `isPodReady`         | Pure  | Checks if pod status means logs are streamable     |
| `interruptibleSleep` | Async | Cancellable sleep returning "timeout" or "aborted" |
| `pollUntil`          | Async | Polls fn until true or aborted                     |

## Testing Strategy

Tests use `Deno.test` and cover the exported pure/async functions. No AWS
credentials, EKS clusters, or helm repos needed.

Run: `deno task test`

### `CLIParse` tests (13 tests)

| Test case                   | Input                                           | Expected                                                                |
| --------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------- |
| mode=run with image-tag     | `--mode=run --image-tag=h69`                    | `{ tag: "run", config: "stress.yaml", imageTag: "h69", dryRun: false }` |
| mode=run with dry-run       | `--mode=run --image-tag=h69 --dry-run`          | `{ tag: "run", config: "stress.yaml", imageTag: "h69", dryRun: true }`  |
| mode=run with custom config | `--mode=run --image-tag=h69 --config=prod.yaml` | `{ tag: "run", config: "prod.yaml", ... }`                              |
| mode=status                 | `--mode=status`                                 | `{ tag: "status", config: "stress.yaml" }`                              |
| mode=logs                   | `--mode=logs`                                   | `{ tag: "logs", config: "stress.yaml" }`                                |
| mode=run missing image-tag  | `--mode=run`                                    | throws                                                                  |
| no args returns help        | (empty)                                         | `{ tag: "help" }`                                                       |
| --help returns help         | `--help`                                        | `{ tag: "help" }`                                                       |
| --init default config       | `--init`                                        | `{ tag: "init", config: "stress.yaml" }`                                |
| --init custom config        | `--init --config=prod.yaml`                     | `{ tag: "init", config: "prod.yaml" }`                                  |
| --doctor default config     | `--doctor`                                      | `{ tag: "doctor", config: "stress.yaml" }`                              |
| --doctor custom config      | `--doctor --config=prod.yaml`                   | `{ tag: "doctor", config: "prod.yaml" }`                                |
| unknown mode                | `--mode=deploy`                                 | throws                                                                  |

### `parseAwsEnv` tests (4 tests)

| Test case               | Input                                                  | Expected                   |
| ----------------------- | ------------------------------------------------------ | -------------------------- |
| extracts AWS vars       | Mixed env with `HOME`, `PATH`, `AWS_ACCESS_KEY_ID` etc | Only `AWS_*` keys returned |
| handles values with `=` | `AWS_SESSION_TOKEN=abc=def=`                           | Value is `"abc=def="`      |
| empty input             | `""`                                                   | `{}`                       |
| no AWS vars             | `HOME=/Users/x\nPATH=/usr/bin`                         | `{}`                       |

### `detectAwsEnv` tests (5 tests)

| Test case                       | Input                                              | Expected                                                               |
| ------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------- |
| all 3 required vars present     | All 3 required + `AWS_REGION` + non-AWS vars       | `{ tag: "found", env: { ...all AWS_* vars } }`                         |
| missing one required var        | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` only | `{ tag: "partial", found: [...], missing: ["AWS_SESSION_TOKEN"] }`     |
| no AWS vars at all              | `{ HOME, SHELL }` (no `AWS_*` keys)                | `{ tag: "none" }`                                                      |
| empty env                       | `{}`                                               | `{ tag: "none" }`                                                      |
| empty string values are missing | `AWS_SECRET_ACCESS_KEY: ""` (other 2 present)      | `{ tag: "partial", found: [...], missing: ["AWS_SECRET_ACCESS_KEY"] }` |

### `redact` tests (3 tests)

| Test case                      | Input                           | Expected       |
| ------------------------------ | ------------------------------- | -------------- |
| sensitive var shows first 4    | key in SENSITIVE_AWS_VARS       | first 4 + **** |
| short sensitive shows only *   | sensitive var, value <= 4 chars | ****           |
| non-sensitive shows full value | key not in SENSITIVE_AWS_VARS   | full value     |

### `parseConfig` tests (5 tests)

| Test case               | Input                                  | Expected                           |
| ----------------------- | -------------------------------------- | ---------------------------------- |
| valid config            | All 8 required fields                  | Config object with matching values |
| missing required field  | Omit `profile`                         | throws listing "profile"           |
| multiple missing fields | Omit `profile`, `cluster`, `namespace` | throws listing all 3               |
| empty string value      | `profile: ""`                          | throws listing "profile"           |
| non-object input        | `null`, `"string"`, `42`, `[]`         | throws "YAML mapping"              |

### `parsePodStatus` tests (4 tests)

| Test case           | Input                                              | Expected                                           |
| ------------------- | -------------------------------------------------- | -------------------------------------------------- |
| normal kubectl line | `"runner-qrqkg   1/1   Running   0   55s"`         | `{ name: "runner-qrqkg", status: "Running" }`      |
| Init status         | `"runner-qrqkg   0/1   Init:0/1   0   10s"`        | `{ name: "runner-qrqkg", status: "Init:0/1" }`     |
| empty line          | `""` or `"   "`                                    | `null`                                             |
| variable whitespace | `"pod-abc   0/1     ContainerCreating     0   3s"` | `{ name: "pod-abc", status: "ContainerCreating" }` |

### `isPodReady` tests (8 tests)

| Test case         | Input                 | Expected |
| ----------------- | --------------------- | -------- |
| Running           | `"Running"`           | `true`   |
| Completed         | `"Completed"`         | `true`   |
| CrashLoopBackOff  | `"CrashLoopBackOff"`  | `true`   |
| ContainerCreating | `"ContainerCreating"` | `false`  |
| PodInitializing   | `"PodInitializing"`   | `false`  |
| Pending           | `"Pending"`           | `false`  |
| Init:0/1          | `"Init:0/1"`          | `false`  |
| Error             | `"Error"`             | `true`   |

### `interruptibleSleep` tests (3 tests)

| Test case                           | Setup                                                | Expected                            |
| ----------------------------------- | ---------------------------------------------------- | ----------------------------------- |
| resolves "timeout" after delay      | `interruptibleSleep(50, signal)`, signal not aborted | `"timeout"`, elapsed ~50ms          |
| resolves "aborted" when pre-aborted | `ac.abort()` before call, 5000ms sleep               | `"aborted"`, resolves immediately   |
| resolves "aborted" on mid-sleep     | `setTimeout(() => ac.abort(), 30)`, 5000ms sleep     | `"aborted"`, elapsed ~30ms (not 5s) |

### `pollUntil` tests (4 tests)

| Test case                      | Setup                                                    | Expected                         |
| ------------------------------ | -------------------------------------------------------- | -------------------------------- |
| returns true when fn succeeds  | fn returns true on 3rd call, interval 20ms               | `true`, fn called 3 times        |
| returns false when aborted     | fn always returns false, abort after 70ms, 30ms interval | `false`, fn called at least once |
| returns false when pre-aborted | signal already aborted                                   | `false`, fn never called         |
| waits interval between polls   | fn returns true on 2nd call, interval 50ms               | `true`, elapsed ~50ms            |

### Total: 49 tests

## Deno Permissions

Shebang:
`#!/usr/bin/env -S deno run --allow-run --allow-env --allow-read --allow-write`

| Permission      | Purpose                                                 |
| --------------- | ------------------------------------------------------- |
| `--allow-run`   | aws-vault, aws, kubectl, helm subprocesses              |
| `--allow-env`   | Read `Deno.env.toObject()` for AWS credential detection |
| `--allow-read`  | Load config file, check values file exists              |
| `--allow-write` | `--init` writes config template to disk                 |

## Distribution

Compiled to a standalone macOS ARM64 binary via `deno compile`. Released via
GitHub Actions on tag push (`v*`).

### Release workflow

On `git tag v1.0.0 && git push --tags`:

1. Verify: `deno fmt --check`, `deno lint`, `deno check`, `deno test`
2. Compile:
   `deno compile --target aarch64-apple-darwin --output stress-darwin-arm64 stress.ts`
3. Publish: `softprops/action-gh-release@v2` creates a GitHub release with the
   binary attached

### Install

```bash
curl -L https://github.com/rnaudi/stress/releases/latest/download/stress-darwin-arm64 -o /usr/local/bin/stress
chmod +x /usr/local/bin/stress
```
