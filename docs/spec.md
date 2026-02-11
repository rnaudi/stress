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
  [PASS] helm values: 2 top-level keys
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
├── stress.yaml            # project-specific config + helm values (gitignored)
├── .gitignore
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
  --mode=clean                   Remove helm release

Options:
  --config=<path>   Config file (default: stress.yaml)
  --dry-run         Show commands without executing (mode=run/clean)

Setup:
  --init            Generate config from template
  --doctor          Check prerequisites and config
  --version         Show version
  --help            Show this help

Examples:
  stress --init                                    Generate config template
  stress --doctor                                  Check prerequisites
  stress --mode=run --image-tag=abc123             Run load test
  stress --mode=run --image-tag=abc123 --dry-run   Preview without executing
  stress --mode=status                             Check pod status
  stress --mode=logs                               Stream runner logs
  stress --mode=clean                              Remove helm release
```

### Types

```ts
type CLI =
  | CLIHelp
  | CLIVersion
  | CLIInit
  | CLIDoctor
  | CLIRun
  | CLIStatus
  | CLILogs
  | CLIClean;

type CLIHelp = { readonly tag: "help" };
type CLIVersion = { readonly tag: "version" };
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
type CLIClean = {
  readonly tag: "clean";
  readonly config: string;
  readonly dryRun: boolean;
};
```

### Arguments

| Flag          | Type      | Required                    | Description                                 |
| ------------- | --------- | --------------------------- | ------------------------------------------- |
| `--mode`      | `string`  | For run/status/logs/clean   | `"run"`, `"status"`, `"logs"`, or `"clean"` |
| `--image-tag` | `string`  | When `mode=run`             | Gatling Docker image tag                    |
| `--dry-run`   | `boolean` | No (default: `false`)       | Helm `--dry-run`, skip pod monitor          |
| `--config`    | `string`  | No (default: `stress.yaml`) | Path to config file                         |
| `--init`      | `boolean` | No                          | Generate config from template               |
| `--doctor`    | `boolean` | No                          | Check prerequisites and config              |
| `--version`   | `boolean` | No                          | Show version                                |
| `--help`      | `boolean` | No                          | Show help                                   |

### Parsing

`CLIParse(args: string[]): CLI` — parses CLI arguments using
`@std/cli/parse-args` into a tagged union. Short-circuit priority:

1. `--version` → `{ tag: "version" }`
2. `--help` or no args → `{ tag: "help" }`
3. `--init` → `{ tag: "init", config }`
4. `--doctor` → `{ tag: "doctor", config }`
5. `--mode` required → exhaustive switch for `"run"`, `"status"`, `"logs"`,
   `"clean"`

### Dispatch (`main()`)

Short-circuit order in `main()`:

1. Parse args → CLI tagged union (exit 1 on error)
2. If `version` → print version, exit 0
3. If `help` → print USAGE, exit 0
4. If `init` → write template to config path, exit
5. If `doctor` → run all checks, exit 0/1
6. Load config from file (`--config` path or default `stress.yaml`)
7. Set up SIGINT handler
8. `execute(cli, cfg)` — exhaustive switch on `cli.tag`: run/status/logs/clean

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
simulation: com.scopely.heimdall.loadtest.smoke.SmokeSimulation
image: heimdall-load-test
repository: scopelybin-docker.jfrog.io/satellites-snapshots

# How long to wait for pods to become ready (seconds, default: 600 = 10 min)
# pod_timeout: 600

# Helm values — passed directly to helm install -f <tempfile>.
# Fields derived from above (cluster_name, image.*, simulationClass)
# are injected automatically via --set.
helm:
  gatling:
    parallelism: 1
    env:
      - name: PREFERENCES_BASE_URL
        value: "https://heimdall-preferences-tophat.adev.scopely.io"
  resources:
    requests:
      cpu: "6"
      memory: "8Gi"
    limits:
      cpu: "10"
      memory: "12Gi"
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
  readonly simulation: string;
  readonly image: string;
  readonly repository: string;
  readonly helm: Record<string, unknown> | null;
  readonly pod_timeout: number;
}
```

All 9 string fields are required. `helm` is optional — if absent, helm install
runs with only `--set` flags (no `-f` values file). `pod_timeout` is optional —
defaults to 600 seconds (10 minutes). Must be a positive number if provided.
`parseConfig(raw: unknown):
Config` validates raw parsed YAML, reports all
missing/empty fields at once (as "missing or empty required fields"), validates
that `helm` is an object if present and `pod_timeout` is a positive number (as
"invalid fields"), and combines both categories into a single error message when
applicable. Required fields present with the wrong type (e.g. `region: 1`) are
reported as "invalid" with the actual type
(`region (must be a string, got
number)`) rather than "missing".

### Embedded template

The config template is embedded in the binary as a string constant
(`CONFIG_TEMPLATE`). `--init` writes it to disk.

### Helm value injection

The following helm values are injected automatically via `--set` from top-level
config fields (users should not duplicate them in `helm:`):

| `--set` flag               | Source field  |
| -------------------------- | ------------- |
| `gatling.cluster_name`     | `cluster`     |
| `gatling.image.name`       | `image`       |
| `gatling.image.repository` | `repository`  |
| `gatling.image.tag`        | `--image-tag` |
| `gatling.simulationClass`  | `simulation`  |

If `helm:` is present, its contents are written to a temp file and passed via
`-f <tempfile>`. The temp file is cleaned up after helm completes.

`checkHelmCollisions(helm, injectedKeys)` recursively walks the `helm:` object
building dot-path keys and returns any that match the 5 injected `--set` paths.
Called in `helmInstall` (warns before install) and `runDoctor` (reports as
`[WARN]`). Users should remove colliding keys from `helm:` since `--set` always
wins.

## Constants

Values that stay in code (not config):

| Constant                 | Value                                                                      |
| ------------------------ | -------------------------------------------------------------------------- |
| `VERSION`                | `"0.1.0"` — tool version, printed by `--version`                           |
| `POLL_INTERVAL`          | `5_000` (ms) — tuning knob for pod polling                                 |
| `DEFAULT_CONFIG`         | `"stress.yaml"` — default config path                                      |
| `CONFIG_TEMPLATE`        | Embedded config YAML template (written by `--init`)                        |
| `REQUIRED_AWS_VARS`      | `["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]`      |
| `SENSITIVE_AWS_VARS`     | `Set(REQUIRED_AWS_VARS)` — values redacted in output                       |
| `REQUIRED_CONFIG_FIELDS` | All 9 Config string field names — used for validation                      |
| `INJECTED_HELM_KEYS`     | 5 dot-path keys auto-injected via `--set` — used by `checkHelmCollisions`  |
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

Writes `stress.yaml` (from `CONFIG_TEMPLATE`) to disk. Refuses if the file
already exists (exit 1 with message, nothing written). If the parent directory
does not exist, reports
`Cannot write <config>: parent directory does not exist.` and exits 1 instead of
throwing a raw `NotFound` error.

### `--doctor` — Check Prerequisites

`runDoctor(cli: CLIDoctor): Promise<void>`

Runs all checks, exits 0 if everything passes, 1 if any required check fails:

1. **Tool checks** (parallel) — `aws-vault --version`,
   `kubectl version --client`, `helm version --short`. Prints `[PASS]` with
   version or `[FAIL]` with install hint.
2. **Config file** — loads and validates `stress.yaml` (or `--config` path).
   Prints `[PASS]` with cluster/namespace summary or `[FAIL]` with error.
3. **Helm values** — informational. Reports how many top-level keys are in the
   `helm:` block, or notes that only `--set` flags will be used if absent. Runs
   `checkHelmCollisions` and prints `[WARN]` for any keys that will be
   overridden by `--set`.
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
     │  On failure → actionable error with profile name and guidance
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
  -f <tempfile>  # only if helm: block present \
  --set gatling.cluster_name=<cluster> \
  --set gatling.image.name=<image> \
  --set gatling.image.repository=<repository> \
  --set gatling.image.tag=<imageTag> \
  --set gatling.simulationClass=<simulation> \
  [--dry-run]
```

If `cfg.helm` is present, writes it to a temp YAML file via `Deno.makeTempFile`,
passes it as `-f <tempfile>`, and cleans up the file in a `finally` block. The
`--set` flags always override values from the file, ensuring no duplication
between config fields and helm values. On failure, captures helm's stderr and
includes it in the error message along with the exit code and a hint about
chart/repo configuration.

### Step 5 — Gatling Lifecycle Monitor

**Function**: `monitorGatling(awsEnv, cfg): Promise<void>`

Skipped entirely when `--dry-run` is set. Pod polling uses `cfg.pod_timeout`
(default 600s) — if pods don't become ready within the timeout, the step throws
a descriptive error. The user can also Ctrl+C at any time.

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

## Mode: clean

`runClean(cli, cfg)` — runs Steps 1-2 (auth + kubeconfig), then uninstalls the
helm release. Supports `--dry-run` to preview without executing.

## Dry Run Mode

When `--dry-run` is passed with `--mode=run` or `--mode=clean`:

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
- `loadConfig` wraps YAML parse errors with the config file path:
  `Failed to parse <configPath>: <original message>`
- `getAwsEnv` wraps `aws-vault exec` failures with the profile name and
  guidance:
  `aws-vault exec failed for profile "<profile>". Check that the
  profile exists in ~/.aws/config and that your MFA device is accessible.`
- `helmInstall` captures stderr on non-zero exit and includes it in the error
  along with the exit code and a hint:
  `Check that chart "<chart>" exists and
  helm repo is configured (helm repo list).`
- `runInit` catches `Deno.errors.NotFound` from `Deno.writeTextFile` and reports
  `Cannot write <config>: parent directory does not exist.` instead of a raw
  error

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
| `waitForPods`        | Uses `pollUntil(fn, POLL_INTERVAL, abort.signal, timeoutMs)` internally           |
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

| Function              | Type  | Description                                        |
| --------------------- | ----- | -------------------------------------------------- |
| `CLIParse`            | Pure  | Parses CLI args into tagged union                  |
| `parseConfig`         | Pure  | Validates raw YAML into Config                     |
| `parseAwsEnv`         | Pure  | Extracts AWS_* vars from env output                |
| `detectAwsEnv`        | Pure  | Detects AWS credential status in env               |
| `redact`              | Pure  | Redacts sensitive values for display               |
| `parsePodStatus`      | Pure  | Parses kubectl pod line into name + status         |
| `isPodReady`          | Pure  | Checks if pod status means logs are streamable     |
| `checkHelmCollisions` | Pure  | Detects helm keys that collide with --set injected |
| `interruptibleSleep`  | Async | Cancellable sleep returning "timeout" or "aborted" |
| `pollUntil`           | Async | Polls fn until true, aborted, or maxMs elapsed     |

## Testing Strategy

Tests use `Deno.test` and cover the exported pure/async functions. No AWS
credentials, EKS clusters, or helm repos needed.

Run: `deno task test`

### `CLIParse` tests (17 tests)

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
| --version                   | `--version`                                     | `{ tag: "version" }`                                                    |
| --version over --help       | `--version --help`                              | `{ tag: "version" }`                                                    |
| mode=clean                  | `--mode=clean`                                  | `{ tag: "clean", config: "stress.yaml", dryRun: false }`                |
| mode=clean with dry-run     | `--mode=clean --dry-run`                        | `{ tag: "clean", config: "stress.yaml", dryRun: true }`                 |

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

### `parseConfig` tests (13 tests)

| Test case                    | Input                                  | Expected                                                              |
| ---------------------------- | -------------------------------------- | --------------------------------------------------------------------- |
| valid config                 | All 9 required string fields           | Config object with matching values                                    |
| missing required field       | Omit `profile`                         | throws listing "profile"                                              |
| multiple missing fields      | Omit `profile`, `cluster`, `namespace` | throws listing all 3                                                  |
| empty string value           | `profile: ""`                          | throws listing "profile"                                              |
| non-object input             | `null`, `"string"`, `42`, `[]`         | throws "YAML mapping"                                                 |
| helm optional                | No `helm` key                          | `cfg.helm === null`                                                   |
| helm passed through          | `helm: { gatling: { parallelism: 2 }}` | `cfg.helm` matches input                                              |
| helm must be object          | `helm: "string"` or `helm: [...]`      | throws listing "helm"                                                 |
| pod_timeout defaults         | No `pod_timeout` key                   | `cfg.pod_timeout === 600`                                             |
| pod_timeout accepts positive | `pod_timeout: 300`                     | `cfg.pod_timeout === 300`                                             |
| pod_timeout must be positive | `pod_timeout: -1` or `pod_timeout: 0`  | throws listing "pod_timeout"                                          |
| wrong-type field             | `region: 1`                            | throws with `"invalid fields: region (must be a string, got number)"` |
| multiple wrong-type fields   | `cluster: true, namespace: [1, 2]`     | throws listing both as invalid                                        |

### `checkHelmCollisions` tests (3 tests)

| Test case           | Input                                                        | Expected                                         |
| ------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| no collisions       | `{ resources: { cpu: "6" } }`                                | `[]`                                             |
| nested collision    | `{ gatling: { image: { name: "foo" } } }`                    | `["gatling.image.name"]`                         |
| multiple collisions | `{ gatling: { cluster_name: "x", image: { name: "foo" } } }` | `["gatling.cluster_name", "gatling.image.name"]` |

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

### `pollUntil` tests (5 tests)

| Test case                         | Setup                                                    | Expected                         |
| --------------------------------- | -------------------------------------------------------- | -------------------------------- |
| returns true when fn succeeds     | fn returns true on 3rd call, interval 20ms               | `true`, fn called 3 times        |
| returns false when aborted        | fn always returns false, abort after 70ms, 30ms interval | `false`, fn called at least once |
| returns false when pre-aborted    | signal already aborted                                   | `false`, fn never called         |
| waits interval between polls      | fn returns true on 2nd call, interval 50ms               | `true`, elapsed ~50ms            |
| returns false when maxMs exceeded | fn always returns false, maxMs 80ms, interval 20ms       | `false`, elapsed ~80ms           |

### Total: 65 tests

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
