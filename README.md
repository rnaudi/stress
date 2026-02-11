# stress

Gatling load tests on EKS, one command.

## Prerequisites

```bash
brew install aws-vault kubectl helm
```

## Install

```bash
curl -L https://github.com/rnaudi/stress/releases/latest/download/stress-darwin-arm64 -o /usr/local/bin/stress
chmod +x /usr/local/bin/stress
```

From source:

```bash
deno compile --allow-run --allow-env --allow-read --allow-write --output stress stress.ts
./stress --help
```

## Quick Start

```bash
stress --init            # generate stress.yaml
vim stress.yaml          # fill in your project values
stress --doctor          # verify tools + config
stress --mode=run --image-tag=h69
```

## Usage

- `--dry-run` — render helm templates without deploying
- `--mode=status` — check pod status (from another terminal)
- `--mode=logs` — tail runner logs (from another terminal)
- `--config=file.yaml` — use a different config file
- `--doctor` — verify tools, config, and AWS credentials
- `Ctrl+C` — cleans up the helm release automatically, no orphaned pods

## Configuration

`stress --init` generates `stress.yaml`:

```yaml
# Where to run
profile: my-aws-profile
cluster: my-cluster
region: us-east-1
namespace: my-namespace

# What to run
release: my-load-test
chart: my-repo/my-chart
simulation: com.example.loadtest.MySimulation
image: my-load-test
repository: my-registry.example.com/my-repo

# Helm values — passed directly to helm install -f <tempfile>.
# Auto-injected fields (see below) don't need to be here.
# Optional.
helm:
  gatling:
    parallelism: 1
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
