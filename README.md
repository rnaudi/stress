# stress

Gatling load tests on EKS, one command.

## Why?

**Running a Gatling load test on EKS is a 4-terminal affair.**

Open a shell for `aws-vault exec`. Another for `kubectl`. Another for
`helm install`. Another to tail logs. Wait for pods. Wait for runners. Wait for
reporters. Copy the report URL. Clean up.

`stress` replaces all of that with one command:

```bash
stress --mode=run --image-tag=abc123
```

It handles auth, kubeconfig, helm install, pod polling, log streaming, and
cleanup on Ctrl+C. You watch the output. When it's done, you're done.

## Prerequisites

Requires [aws-vault](https://github.com/99designs/aws-vault),
[kubectl](https://kubernetes.io/docs/tasks/tools/), and
[helm](https://helm.sh/docs/intro/install/).

```bash
brew install aws-vault kubectl helm
```

## Installation

```bash
curl -L https://github.com/rnaudi/stress/releases/latest/download/stress-darwin-arm64 -o /usr/local/bin/stress
chmod +x /usr/local/bin/stress
```

### From source

```bash
deno compile --allow-run --allow-env --allow-read --allow-write --output stress stress.ts
./stress --help
```

## Quick Start

```bash
# 1. Generate config files
stress --init

# 2. Edit with your project values
vim stress.yaml
vim values.yaml

# 3. Verify everything is set up
stress --doctor

# 4. Run
stress --mode=run --image-tag=h69
```

That's it. Four commands from install to running load test.

## Common Use Cases

**Dry run first:**

```bash
stress --mode=run --image-tag=h69 --dry-run
```

Renders helm templates without deploying. Steps 1-4 run, pod monitoring is
skipped.

**Check pod status (from another terminal):**

```bash
stress --mode=status
```

**Tail runner logs (from another terminal):**

```bash
stress --mode=logs
```

**Multiple projects:**

```bash
stress --init --config=staging.yaml
stress --mode=run --image-tag=h69 --config=staging.yaml
```

**Interrupt safely:**

Ctrl+C during a run cleans up the helm release automatically. No orphaned pods.

## Configuration

`stress --init` generates two files:

### `stress.yaml` — where and what to run

```yaml
# Where to run
profile: my-aws-profile
cluster: my-cluster
region: us-east-1
namespace: my-namespace

# What to run
release: my-load-test
chart: my-repo/my-chart
values: values.yaml
simulation: com.example.loadtest.MySimulation
```

All 8 fields are required. `stress --doctor` validates them.

### `values.yaml` — helm values for your chart

```yaml
gatling:
  cluster_name: "my-cluster"
  image:
    name: "my-load-test"
    repository: "my-registry.example.com/my-repo"
  parallelism: 1
  simulationClass: "com.example.loadtest.MySimulation"
  env:
    - name: BASE_URL
      value: "https://my-service.example.com"
resources:
  requests:
    cpu: "6"
    memory: "8Gi"
  limits:
    cpu: "10"
    memory: "12Gi"
```

Passed to `helm install -f values.yaml`. See `values.example.yaml` for a
reference template.

## Verify Setup

```bash
stress --doctor
```

```
[PASS] aws-vault: 7.2.0
[PASS] kubectl: v1.28.2
[PASS] helm: v3.14.0
[PASS] stress.yaml: valid (cluster=analytics, namespace=load-test)
[PASS] values: values.yaml exists
[INFO] AWS credentials: not in env (will prompt via aws-vault)
```

Checks tools, config, values file, and AWS credential status. Exit 1 if anything
required is missing.

## Development

```bash
deno task test        # 49 tests, pure functions only — no AWS/EKS needed
deno fmt              # format
deno lint             # lint
deno check stress.ts  # type-check
```

See [docs/spec.md](docs/spec.md) for engineering internals.
