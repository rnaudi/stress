#!/usr/bin/env -S deno run --allow-run --allow-env --allow-read --allow-write
/**
 * stress — Gatling load test runner for EKS.
 *
 * Replaces a manual multi-terminal workflow (aws-vault, kubectl, helm, log
 * tailing) with a single `--mode=run --image-tag=<tag>` invocation.
 * Project-specific values (cluster, namespace, chart, etc.) come from
 * stress.yaml (or a custom path via --config).
 *
 * Design:
 * - Single-file script — all logic here, all tests in stress_test.ts.
 * - Tagged union CLI with exhaustive dispatch.
 * - AbortController for cancellation — module-level controller propagated to
 *   all subprocess `.signal()` calls. SIGINT sets `interrupted` flag so the
 *   finally block can clean up the helm release.
 * - Unawaited promises for background tasks — `kubectl get pod -w` runs
 *   concurrently via a separate AbortController, killed in finally.
 */
import { parseArgs } from "@std/cli/parse-args";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import $ from "@david/dax";

const POLL_INTERVAL = 5_000;
const DEFAULT_CONFIG = "stress.yaml" as const;
const VERSION = "0.1.0";

/** Embedded config template — written to disk by --init. */
const CONFIG_TEMPLATE = `\
# stress.yaml — project-specific configuration for stress.
# Edit the values below for your project.

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

# How long to wait for pods to become ready (seconds, default: 600 = 10 min)
# pod_timeout: 600

# Helm values — passed directly to helm install -f <tempfile>.
# Fields derived from above (cluster_name, image.*, simulationClass)
# are injected automatically via --set. Don't duplicate them here.
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
`;

/** Project-specific configuration loaded from stress.yaml. */
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

const REQUIRED_CONFIG_FIELDS = [
  "profile",
  "cluster",
  "region",
  "namespace",
  "release",
  "chart",
  "simulation",
  "image",
  "repository",
] as const;

/**
 * Helm key paths injected automatically via --set during helm install.
 * If any of these appear in the user's helm: block, they will be silently
 * overridden. checkHelmCollisions detects this and warns the user.
 */
const INJECTED_HELM_KEYS = [
  "gatling.cluster_name",
  "gatling.image.name",
  "gatling.image.repository",
  "gatling.image.tag",
  "gatling.simulationClass",
] as const;

/**
 * Walks a nested object and returns all dot-path keys that collide with
 * the injected --set keys. Used to warn the user before helm install.
 */
export function checkHelmCollisions(
  helm: Record<string, unknown>,
  injectedKeys: readonly string[] = INJECTED_HELM_KEYS,
): string[] {
  const collisions: string[] = [];
  const injectedSet = new Set(injectedKeys);

  function walk(obj: Record<string, unknown>, prefix: string): void {
    for (const key of Object.keys(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (injectedSet.has(path)) {
        collisions.push(path);
      }
      const val = obj[key];
      if (val !== null && typeof val === "object" && !Array.isArray(val)) {
        walk(val as Record<string, unknown>, path);
      }
    }
  }

  walk(helm, "");
  return collisions;
}

/**
 * Validates raw parsed YAML into a Config object.
 * Reports all problems at once so the user can fix them in one pass.
 */
export function parseConfig(raw: unknown): Config {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config must be a YAML mapping (key: value pairs)");
  }

  const obj = raw as Record<string, unknown>;
  const missing: string[] = [];
  const invalid: string[] = [];

  for (const field of REQUIRED_CONFIG_FIELDS) {
    const val = obj[field];
    if (val === undefined || val === null) {
      missing.push(field);
    } else if (typeof val !== "string") {
      invalid.push(`${field} (must be a string, got ${typeof val})`);
    } else if (val.trim().length === 0) {
      missing.push(field);
    }
  }

  // helm: is optional, but if present must be an object
  if (obj.helm !== undefined && obj.helm !== null) {
    if (typeof obj.helm !== "object" || Array.isArray(obj.helm)) {
      invalid.push("helm (must be a YAML mapping)");
    }
  }

  // pod_timeout: optional, defaults to 600, must be a positive number
  let podTimeout = 600;
  if (obj.pod_timeout !== undefined && obj.pod_timeout !== null) {
    if (typeof obj.pod_timeout !== "number" || obj.pod_timeout <= 0) {
      invalid.push("pod_timeout (must be a positive number)");
    } else {
      podTimeout = obj.pod_timeout;
    }
  }

  if (missing.length > 0 || invalid.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) {
      parts.push(`missing or empty required fields: ${missing.join(", ")}`);
    }
    if (invalid.length > 0) {
      parts.push(`invalid fields: ${invalid.join(", ")}`);
    }
    throw new Error(`config: ${parts.join("; ")}`);
  }

  return {
    profile: obj.profile as string,
    cluster: obj.cluster as string,
    region: obj.region as string,
    namespace: obj.namespace as string,
    release: obj.release as string,
    chart: obj.chart as string,
    simulation: obj.simulation as string,
    image: obj.image as string,
    repository: obj.repository as string,
    helm: (obj.helm as Record<string, unknown>) ?? null,
    pod_timeout: podTimeout,
  };
}

/** Reads config file, parses YAML, validates into Config. */
async function loadConfig(configPath: string): Promise<Config> {
  let text: string;
  try {
    text = await Deno.readTextFile(configPath);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(
        `${configPath} not found. Run stress --init to create one.`,
      );
    }
    throw e;
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new Error(
      `Failed to parse ${configPath}: ${(e as Error).message}`,
    );
  }
  return parseConfig(raw);
}

/** Derived label for runner pods. */
function runnerLabel(cfg: Config): string {
  return `job-name=${cfg.release}-runner`;
}

/** Derived label for reporter pods. */
function reporterLabel(cfg: Config): string {
  return `job-name=${cfg.release}-reporter`;
}

/** Short simulation class name for display. */
function simulationShort(cfg: Config): string {
  return cfg.simulation.split(".").pop() ?? cfg.simulation;
}

const REQUIRED_AWS_VARS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
] as const;

/** Controls which env var values get redacted in printAwsEnv output. */
const SENSITIVE_AWS_VARS: ReadonlySet<string> = new Set(REQUIRED_AWS_VARS);

const USAGE = `
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
`.trim();

const abort = new AbortController();
let interrupted = false;

/** Tagged union — each variant maps to a CLI action dispatched by main(). */
type CLI =
  | CLIHelp
  | CLIVersion
  | CLIInit
  | CLIDoctor
  | CLIRun
  | CLIStatus
  | CLILogs
  | CLIClean;

type CLIHelp = {
  readonly tag: "help";
};

type CLIVersion = {
  readonly tag: "version";
};

type CLIInit = {
  readonly tag: "init";
  readonly config: string;
};

type CLIDoctor = {
  readonly tag: "doctor";
  readonly config: string;
};

type CLIRun = {
  readonly tag: "run";
  readonly config: string;
  readonly imageTag: string;
  readonly dryRun: boolean;
};

type CLIStatus = {
  readonly tag: "status";
  readonly config: string;
};

type CLILogs = {
  readonly tag: "logs";
  readonly config: string;
};

type CLIClean = {
  readonly tag: "clean";
  readonly config: string;
  readonly dryRun: boolean;
};

/** Parses CLI arguments into a tagged union variant for exhaustive dispatch. */
export function CLIParse(args: string[]): CLI {
  const stringFlags = ["mode", "image-tag", "config"];
  const booleanFlags = ["dry-run", "help", "version", "init", "doctor"];
  const flags = parseArgs(args, {
    string: stringFlags,
    boolean: booleanFlags,
    default: { "dry-run": false },
  });

  const knownKeys = new Set([...stringFlags, ...booleanFlags, "_"]);
  const unknown = Object.keys(flags).filter((k) => !knownKeys.has(k));
  if (unknown.length > 0) {
    throw new Error(`Unknown flag: --${unknown[0]}`);
  }
  if (flags._.length > 0) {
    throw new Error(`Unexpected argument: ${flags._[0]}`);
  }

  const config = flags.config ?? DEFAULT_CONFIG;

  if (flags.version) {
    return { tag: "version" };
  }

  if (flags.help || args.length === 0) {
    return { tag: "help" };
  }

  if (flags.init) {
    return { tag: "init", config };
  }

  if (flags.doctor) {
    return { tag: "doctor", config };
  }

  if (!flags.mode) {
    throw new Error(USAGE);
  }

  switch (flags.mode) {
    case "run": {
      const imageTag = flags["image-tag"];
      if (!imageTag) {
        throw new Error("--image-tag is required for mode=run");
      }
      return { tag: "run", config, imageTag, dryRun: flags["dry-run"] };
    }
    case "status":
      return { tag: "status", config };
    case "logs":
      return { tag: "logs", config };
    case "clean":
      return { tag: "clean", config, dryRun: flags["dry-run"] };
    default:
      throw new Error(
        `Unknown mode: ${flags.mode}, use "run", "status", "logs", or "clean".`,
      );
  }
}

/**
 * Parses raw `env` output and returns only AWS_* environment variables.
 * Handles values containing '=' characters (e.g. session tokens).
 */
export function parseAwsEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1);
    if (key.startsWith("AWS_")) {
      env[key] = value;
    }
  }
  return env;
}

/** Result of detecting AWS credentials in the current environment. */
type AwsDetection =
  | { readonly tag: "found"; readonly env: Record<string, string> }
  | {
    readonly tag: "partial";
    readonly found: string[];
    readonly missing: string[];
  }
  | { readonly tag: "none" };

/**
 * Inspects a flat env record for AWS credentials.
 * Returns "found" with all AWS_* vars if all 3 required vars are present,
 * "partial" if some but not all are present, or "none" if zero are present.
 */
export function detectAwsEnv(
  env: Record<string, string>,
): AwsDetection {
  const found: string[] = [];
  const missing: string[] = [];
  for (const key of REQUIRED_AWS_VARS) {
    const val = env[key];
    if (typeof val === "string" && val.length > 0) {
      found.push(key);
    } else {
      missing.push(key);
    }
  }

  if (missing.length === REQUIRED_AWS_VARS.length) {
    return { tag: "none" };
  }

  if (missing.length > 0) {
    return { tag: "partial", found, missing };
  }

  // Why all AWS_* and not just the 3 required? Subprocesses (aws, kubectl, helm)
  // need additional vars like AWS_REGION, AWS_DEFAULT_REGION, AWS_SECURITY_TOKEN.
  const awsEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("AWS_")) {
      awsEnv[key] = value;
    }
  }
  return { tag: "found", env: awsEnv };
}

/**
 * Statuses from the kubectl STATUS column that mean the pod's main containers
 * have NOT started yet. These come from the table-format output, not
 * `status.phase` — phase stays "Pending" through all init states.
 */
const NOT_READY_STATUSES: ReadonlySet<string> = new Set([
  "Pending",
  "ContainerCreating",
  "PodInitializing",
]);

/**
 * Parses one line of `kubectl get pods --no-headers` output.
 * Format: NAME  READY  STATUS  RESTARTS  AGE
 * Returns { name, status } or null for empty/unparseable lines.
 */
export function parsePodStatus(
  line: string,
): { name: string; status: string } | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 3) return null;
  return { name: parts[0], status: parts[2] };
}

/**
 * Returns true if the kubectl STATUS column means we can stream logs
 * (main containers have started). Not-ready: Pending, ContainerCreating,
 * PodInitializing, Init:* (e.g. Init:0/1). Everything else is ready
 * (Running, Completed, CrashLoopBackOff, Error, etc.).
 */
export function isPodReady(status: string): boolean {
  if (NOT_READY_STATUSES.has(status)) return false;
  if (status.startsWith("Init:")) return false;
  return true;
}

/**
 * Sleeps for `ms` milliseconds, but resolves early if `signal` is aborted.
 * Returns "timeout" on normal completion, "aborted" if interrupted.
 * Properly cleans up the timer on abort (unlike $.sleep which leaks).
 */
export function interruptibleSleep(
  ms: number,
  signal: AbortSignal,
): Promise<"timeout" | "aborted"> {
  if (signal.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve("timeout");
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve("aborted");
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Polls `fn` every `intervalMs` until it returns true, signal is aborted,
 * or `maxMs` milliseconds have elapsed (if provided).
 * Returns true if fn completed successfully, false if aborted or timed out.
 */
export async function pollUntil(
  fn: () => Promise<boolean>,
  intervalMs: number,
  signal: AbortSignal,
  maxMs?: number,
): Promise<boolean> {
  const start = Date.now();
  while (!signal.aborted) {
    if (maxMs !== undefined && Date.now() - start >= maxMs) return false;
    if (await fn()) return true;
    const result = await interruptibleSleep(intervalMs, signal);
    if (result === "aborted") return false;
  }
  return false;
}

/** Prints the run configuration and pipeline steps before execution. */
function printConfig(cli: CLIRun, cfg: Config): void {
  const lines = [
    "",
    `  Gatling Load Test Runner${cli.dryRun ? "  [DRY RUN]" : ""}`,
    "  ─────────────────────────────────────────────────────────",
    `  Config:       ${cli.config}`,
    `  Profile:      ${cfg.profile}`,
    `  Cluster:      ${cfg.cluster} (${cfg.region})`,
    `  Namespace:    ${cfg.namespace}`,
    `  Release:      ${cfg.release}`,
    `  Chart:        ${cfg.chart}`,
    `  Image tag:    ${cli.imageTag}`,
    `  Image:        ${cfg.repository}/${cfg.image}`,
    `  Simulation:   ${simulationShort(cfg)}`,
    "  ─────────────────────────────────────────────────────────",
    "  Pipeline:",
    `    1.  aws-vault exec ${cfg.profile} -- env`,
    `    2.  aws eks update-kubeconfig --name ${cfg.cluster} --region ${cfg.region}`,
    `    3.  helm -n ${cfg.namespace} uninstall ${cfg.release}  (if exists)`,
    `    4.  helm -n ${cfg.namespace} install ${cfg.release} ${cfg.chart}`,
    `    5a. kubectl get pod -n ${cfg.namespace} -w  (background watch)`,
    `    5b. Stream runner logs  (-l ${runnerLabel(cfg)})`,
    `    5c. Stream reporter logs  (-l ${reporterLabel(cfg)})`,
    "  ─────────────────────────────────────────────────────────",
    "",
  ];
  for (const line of lines) {
    $.log(line);
  }
}

/** Logs a shell command that is about to run. */
function cmd(s: string): void {
  $.logLight(`  $ ${s}`);
}

/** Logs a success message. */
function ok(s: string): void {
  $.logStep("  OK", s);
}

/** Redacts a value: shows first 4 chars + **** for secrets, full value for non-sensitive. */
export function redact(key: string, value: string): string {
  if (!SENSITIVE_AWS_VARS.has(key)) return value;
  if (value.length <= 4) return "****";
  return value.slice(0, 4) + "****";
}

/** Prints AWS env vars with redacted sensitive values, aligned. */
function printAwsEnv(env: Record<string, string>): void {
  const keys = Object.keys(env).sort();
  if (keys.length === 0) return;
  const maxLen = Math.max(...keys.map((k) => k.length));
  for (const key of keys) {
    const padded = key.padEnd(maxLen);
    $.logLight(`    ${padded} = ${redact(key, env[key])}`);
  }
}

/**
 * Obtains AWS credentials for subprocess use.
 * Checks the current environment first (e.g. running inside aws-vault already);
 * falls back to launching `aws-vault exec` if credentials are absent or partial.
 */
async function getAwsEnv(cfg: Config): Promise<Record<string, string>> {
  const detection = detectAwsEnv(Deno.env.toObject());

  switch (detection.tag) {
    case "found":
      ok(
        `found ${
          Object.keys(detection.env).length
        } AWS env vars in current environment`,
      );
      printAwsEnv(detection.env);
      return detection.env;

    case "partial":
      $.logWarn(
        "  Warning",
        `partial AWS credentials in environment — found ${
          detection.found.join(", ")
        } but missing ${detection.missing.join(", ")}`,
      );
      $.logLight("  Falling back to aws-vault...");
      break;

    case "none":
      $.logLight("  No AWS credentials in environment, launching aws-vault...");
      break;
  }

  cmd(`aws-vault exec ${cfg.profile} --prompt=osascript -- env`);
  let raw: string;
  try {
    raw = await $`aws-vault exec ${cfg.profile} --prompt=osascript -- env`
      .quiet()
      .text();
  } catch {
    throw new Error(
      `aws-vault exec failed for profile "${cfg.profile}". ` +
        "Check that the profile exists in ~/.aws/config and that your MFA device is accessible.",
    );
  }
  const env = parseAwsEnv(raw);
  ok(`captured ${Object.keys(env).length} AWS env vars via aws-vault`);
  printAwsEnv(env);
  return env;
}

/** Configures kubectl to point at the EKS cluster. */
async function updateKubeconfig(
  awsEnv: Record<string, string>,
  cfg: Config,
): Promise<void> {
  cmd(
    `aws eks update-kubeconfig --name ${cfg.cluster} --region ${cfg.region}`,
  );
  await $`aws eks update-kubeconfig --name ${cfg.cluster} --region ${cfg.region}`
    .env(awsEnv)
    .quiet();
  ok(`kubeconfig updated for ${cfg.cluster}`);
}

/** Uninstalls the helm release. Uses `.noThrow()` because the release may not exist. */
async function helmUninstall(
  awsEnv: Record<string, string>,
  cfg: Config,
  dryRun: boolean,
): Promise<void> {
  const dryFlag = dryRun ? " --dry-run" : "";
  cmd(`helm -n ${cfg.namespace} uninstall ${cfg.release}${dryFlag}`);

  const args = ["helm", "-n", cfg.namespace, "uninstall", cfg.release];
  if (dryRun) args.push("--dry-run");

  const result = await $`${args}`
    .env(awsEnv)
    .noThrow()
    .quiet();

  if (result.code === 0) {
    ok(`release "${cfg.release}" uninstalled${dryRun ? " (dry-run)" : ""}`);
  } else {
    $.logLight(
      `  No existing release "${cfg.release}" found. Skipping.`,
    );
  }
}

/** Installs the load test helm chart with the given image tag and simulation. */
async function helmInstall(
  awsEnv: Record<string, string>,
  cfg: Config,
  imageTag: string,
  dryRun: boolean,
): Promise<void> {
  const setFlags = [
    `gatling.cluster_name=${cfg.cluster}`,
    `gatling.image.name=${cfg.image}`,
    `gatling.image.repository=${cfg.repository}`,
    `gatling.image.tag=${imageTag}`,
    `gatling.simulationClass=${cfg.simulation}`,
  ];

  const setDisplay = setFlags.map((f) => `        --set ${f}`).join(" \\\n");
  const dryFlag = dryRun ? " \\\n        --dry-run" : "";

  let valuesFileArg = "";
  let tempValuesPath: string | null = null;

  if (cfg.helm) {
    const collisions = checkHelmCollisions(cfg.helm);
    for (const key of collisions) {
      $.logWarn(
        "Warning",
        `helm values key '${key}' will be overridden by --set`,
      );
    }

    tempValuesPath = await Deno.makeTempFile({
      prefix: "stress-values-",
      suffix: ".yaml",
    });
    await Deno.writeTextFile(
      tempValuesPath,
      stringifyYaml(cfg.helm as Record<string, unknown>),
    );
    valuesFileArg = ` \\\n        -f ${tempValuesPath}`;
  }

  cmd(
    `helm -n ${cfg.namespace} install ${cfg.release} ${cfg.chart}${valuesFileArg} \\\n${setDisplay}${dryFlag}`,
  );

  const args = [
    "helm",
    "-n",
    cfg.namespace,
    "install",
    cfg.release,
    cfg.chart,
  ];

  if (tempValuesPath) {
    args.push("-f", tempValuesPath);
  }

  for (const flag of setFlags) {
    args.push("--set", flag);
  }
  if (dryRun) args.push("--dry-run");

  try {
    const result = await $`${args}`
      .env(awsEnv)
      .noThrow()
      .quiet("stdout")
      .stderr("piped");
    if (result.code !== 0) {
      const stderr = result.stderrBytes
        ? new TextDecoder().decode(result.stderrBytes).trim()
        : "";
      const detail = stderr ? `:\n${stderr}` : "";
      throw new Error(
        `helm install failed (exit ${result.code})${detail}\n` +
          `Check that chart "${cfg.chart}" exists and helm repo is configured (helm repo list).`,
      );
    }
    ok(
      `release "${cfg.release}" installed${
        dryRun ? " (dry-run)" : ""
      } (image: ${imageTag}, sim: ${simulationShort(cfg)})`,
    );
  } finally {
    if (tempValuesPath) {
      try {
        await Deno.remove(tempValuesPath);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/**
 * Polls `kubectl get pods --no-headers` (plain text) until at least one pod
 * reaches a log-streamable status. Only prints when the output changes, so
 * the user sees state transitions (e.g. Pending -> ContainerCreating -> Running)
 * rather than 14 identical "Pending" lines.
 *
 * Why plain text instead of `-o json`? Kubernetes `status.phase` stays
 * "Pending" through ContainerCreating and PodInitializing — the STATUS column
 * from the default table output reflects the real container lifecycle.
 */
async function waitForPods(
  awsEnv: Record<string, string>,
  cfg: Config,
  label: string,
  timeoutMs: number,
): Promise<void> {
  let lastOutput = "";
  let pollCount = 0;
  let noPodsPrinted = false;
  const ready = await pollUntil(
    async () => {
      pollCount++;
      const elapsed = Math.round((pollCount * POLL_INTERVAL) / 1000);

      const output =
        await $`kubectl get pods -n ${cfg.namespace} -l ${label} --no-headers`
          .env(awsEnv)
          .quiet()
          .noThrow()
          .text();

      const trimmed = output.trim();

      if (trimmed === "") {
        if (!noPodsPrinted) {
          $.logLight(`  [${elapsed}s] no pods yet`);
          noPodsPrinted = true;
        }
        lastOutput = "";
        return false;
      }

      if (trimmed !== lastOutput) {
        lastOutput = trimmed;
        noPodsPrinted = false;
        for (const line of trimmed.split("\n")) {
          $.logLight(`  [${elapsed}s] ${line.trim()}`);
        }
      }

      const pods = trimmed.split("\n")
        .map((l) => parsePodStatus(l))
        .filter((p): p is { name: string; status: string } => p !== null);

      if (pods.length > 0 && pods.some((p) => isPodReady(p.status))) {
        const summary = pods.map((p) => `${p.name} (${p.status})`).join(", ");
        ok(`pods ready: ${summary}`);
        return true;
      }

      return false;
    },
    POLL_INTERVAL,
    abort.signal,
    timeoutMs,
  );

  if (!ready && !abort.signal.aborted) {
    const mins = Math.round(timeoutMs / 60_000);
    throw new Error(
      `Timed out after ${mins}m waiting for pods matching '${label}'. ` +
        "Check cluster capacity, image pull status, and node selectors.",
    );
  }
}

/** Streams logs for pods matching `label` until they complete or SIGINT fires. */
async function streamLogs(
  awsEnv: Record<string, string>,
  cfg: Config,
  label: string,
): Promise<void> {
  cmd(
    `kubectl logs -f -n ${cfg.namespace} -l ${label} --all-containers --ignore-errors=true`,
  );
  await $`kubectl logs -f -n ${cfg.namespace} -l ${label} --all-containers --ignore-errors=true`
    .env(awsEnv)
    .signal(abort.signal)
    .noThrow();
}

/**
 * Full lifecycle monitoring after helm install.
 * Uses two AbortControllers: the module-level `abort` for SIGINT cancellation
 * of log streams, and a local `watchAbort` for the background pod watch.
 * The pod watch is an unawaited promise — it runs concurrently and is killed
 * in the finally block regardless of success or interrupt.
 */
async function monitorGatling(
  awsEnv: Record<string, string>,
  cfg: Config,
): Promise<void> {
  // 5a — background pod watch (unawaited promise, separate abort controller)
  const watchAbort = new AbortController();
  $.logStep("Step 5a:", "Starting background pod watch...");
  cmd(`kubectl get pod -n ${cfg.namespace} -w`);
  const podWatch = $`kubectl get pod -n ${cfg.namespace} -w`
    .env(awsEnv)
    .signal(watchAbort.signal)
    .noThrow();
  // ↑ NOT awaited — runs concurrently as unawaited promise

  try {
    // 5b — wait for runner pods, then stream their logs
    $.logStep("Step 5b:", "Waiting for runner pods...");
    cmd(
      `kubectl get pods -n ${cfg.namespace} -l ${
        runnerLabel(cfg)
      } --no-headers  (polling every ${POLL_INTERVAL / 1000}s)`,
    );
    await waitForPods(awsEnv, cfg, runnerLabel(cfg), cfg.pod_timeout * 1000);
    if (abort.signal.aborted) return;

    $.logStep("Step 5b:", "Streaming runner logs...");
    await streamLogs(awsEnv, cfg, runnerLabel(cfg));
    if (abort.signal.aborted) return;
    ok("runner logs stream ended (runners completed)");

    // 5c — wait for reporter pods, then stream their logs
    $.logStep("Step 5c:", "Waiting for reporter pods...");
    cmd(
      `kubectl get pods -n ${cfg.namespace} -l ${
        reporterLabel(cfg)
      } --no-headers  (polling every ${POLL_INTERVAL / 1000}s)`,
    );
    await waitForPods(awsEnv, cfg, reporterLabel(cfg), cfg.pod_timeout * 1000);
    if (abort.signal.aborted) return;

    $.logStep("Step 5c:", "Streaming reporter logs...");
    await streamLogs(awsEnv, cfg, reporterLabel(cfg));
    if (abort.signal.aborted) return;
    ok("reporter logs stream ended (reporter completed)");
  } finally {
    // Always kill background pod watch
    watchAbort.abort();
    await podWatch;

    // If interrupted by Ctrl+C, clean up the helm release
    if (interrupted) {
      $.logWarn("Cleanup", "Uninstalling helm release...");
      await helmUninstall(awsEnv, cfg, false);
    }
  }
}

/** Runs the full pipeline: auth, kubeconfig, uninstall, install, monitor. */
async function runPipeline(cli: CLIRun, cfg: Config): Promise<void> {
  printConfig(cli, cfg);

  $.logStep("Step 1:", "Authenticating with AWS vault...");
  const awsEnv = await getAwsEnv(cfg);

  $.logStep("Step 2:", "Updating EKS kubeconfig...");
  await updateKubeconfig(awsEnv, cfg);

  $.logStep("Step 3:", "Uninstalling previous helm release...");
  await helmUninstall(awsEnv, cfg, cli.dryRun);

  $.logStep("Step 4:", "Installing load test helm chart...");
  await helmInstall(awsEnv, cfg, cli.imageTag, cli.dryRun);

  if (cli.dryRun) {
    $.logLight("  Skipping pod monitoring (dry-run).");
    return;
  }

  $.logStep("Step 5:", "Monitoring Gatling lifecycle...");
  await monitorGatling(awsEnv, cfg);
}

/** Authenticates, then shows current runner and reporter pod status. */
async function runStatus(_cli: CLIStatus, cfg: Config): Promise<void> {
  $.logStep("Step 1:", "Authenticating with AWS vault...");
  const awsEnv = await getAwsEnv(cfg);

  $.logStep("Step 2:", "Updating EKS kubeconfig...");
  await updateKubeconfig(awsEnv, cfg);

  $.logStep("Status:", "Current pod status");
  cmd(`kubectl get pods -n ${cfg.namespace} -l ${runnerLabel(cfg)}`);
  await $`kubectl get pods -n ${cfg.namespace} -l ${runnerLabel(cfg)}`
    .env(awsEnv)
    .noThrow();

  cmd(`kubectl get pods -n ${cfg.namespace} -l ${reporterLabel(cfg)}`);
  await $`kubectl get pods -n ${cfg.namespace} -l ${reporterLabel(cfg)}`
    .env(awsEnv)
    .noThrow();
}

/** Authenticates, then streams runner logs for an in-progress or completed run. */
async function runLogs(_cli: CLILogs, cfg: Config): Promise<void> {
  $.logStep("Step 1:", "Authenticating with AWS vault...");
  const awsEnv = await getAwsEnv(cfg);

  $.logStep("Step 2:", "Updating EKS kubeconfig...");
  await updateKubeconfig(awsEnv, cfg);

  $.logStep("Logs:", "Streaming runner logs...");
  await streamLogs(awsEnv, cfg, runnerLabel(cfg));
}

/**
 * Writes config template to disk.
 * Refuses if file already exists.
 */
async function runInit(cli: CLIInit): Promise<void> {
  try {
    await Deno.stat(cli.config);
    $.logError(
      `${cli.config} already exists. Remove it first if you want to regenerate.`,
    );
    Deno.exit(1);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }

  try {
    await Deno.writeTextFile(cli.config, CONFIG_TEMPLATE);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      $.logError(
        `Cannot write ${cli.config}: parent directory does not exist.`,
      );
      Deno.exit(1);
    }
    throw e;
  }
  $.logStep("Created", cli.config);
  $.logLight("  Edit it with your project values.");
}

/**
 * Checks prerequisites and config. Runs tool version checks, validates config
 * file, reports helm block status, and reports AWS credential status.
 * Exit 0 if all required checks pass, exit 1 otherwise.
 */
async function runDoctor(cli: CLIDoctor): Promise<void> {
  let failures = 0;

  // Tool checks — run in parallel
  const tools = [
    { name: "aws-vault", cmd: ["aws-vault", "--version"] },
    { name: "kubectl", cmd: ["kubectl", "version", "--client", "-o", "json"] },
    { name: "helm", cmd: ["helm", "version", "--short"] },
  ];

  const results = await Promise.all(
    tools.map(async (tool) => {
      try {
        const output = await $`${tool.cmd}`.quiet().noThrow().text();
        return { name: tool.name, ok: true, output: output.trim() };
      } catch {
        return { name: tool.name, ok: false, output: "" };
      }
    }),
  );

  for (const r of results) {
    if (r.ok) {
      let version = r.output;
      // Parse kubectl JSON for clean version
      if (r.name === "kubectl") {
        try {
          const parsed = JSON.parse(r.output);
          version = parsed?.clientVersion?.gitVersion ?? r.output;
        } catch {
          // use raw output
        }
      }
      // Show first line only (aws-vault prints multi-line sometimes)
      version = version.split("\n")[0];
      $.logStep("[PASS]", `${r.name}: ${version}`);
    } else {
      $.logError(`[FAIL] ${r.name}: not found — brew install ${r.name}`);
      failures++;
    }
  }

  // Config file check
  let cfg: Config | null = null;
  try {
    cfg = await loadConfig(cli.config);
    $.logStep(
      "[PASS]",
      `${cli.config}: valid (cluster=${cfg.cluster}, namespace=${cfg.namespace})`,
    );
  } catch (e) {
    $.logError(`[FAIL] ${(e as Error).message}`);
    failures++;
  }

  // Helm values block — informational
  if (cfg) {
    if (cfg.helm) {
      $.logStep(
        "[PASS]",
        `helm values: ${Object.keys(cfg.helm).length} top-level keys`,
      );
      const collisions = checkHelmCollisions(cfg.helm);
      for (const key of collisions) {
        $.logWarn(
          "[WARN]",
          `helm key '${key}' will be overridden by --set — remove it from helm:`,
        );
      }
    } else {
      $.logStep("[INFO]", "helm values: none (only --set flags will be used)");
    }
  }

  // AWS credentials — informational, not a failure
  const detection = detectAwsEnv(Deno.env.toObject());
  switch (detection.tag) {
    case "found":
      $.logStep(
        "[INFO]",
        `AWS credentials: found (${Object.keys(detection.env).length} vars)`,
      );
      break;
    case "partial":
      $.logStep(
        "[INFO]",
        `AWS credentials: partial (missing ${detection.missing.join(", ")})`,
      );
      break;
    case "none":
      $.logStep(
        "[INFO]",
        "AWS credentials: not in env (will prompt via aws-vault)",
      );
      break;
  }

  if (failures > 0) {
    Deno.exit(1);
  }
}

/** Authenticates, then uninstalls the helm release. */
async function runClean(cli: CLIClean, cfg: Config): Promise<void> {
  $.logStep("Step 1:", "Authenticating with AWS vault...");
  const awsEnv = await getAwsEnv(cfg);

  $.logStep("Step 2:", "Updating EKS kubeconfig...");
  await updateKubeconfig(awsEnv, cfg);

  $.logStep("Clean:", "Uninstalling helm release...");
  await helmUninstall(awsEnv, cfg, cli.dryRun);
}

/** Exhaustive dispatch for operational modes that require config. */
async function execute(
  cli: CLIRun | CLIStatus | CLILogs | CLIClean,
  cfg: Config,
): Promise<void> {
  switch (cli.tag) {
    case "run":
      return await runPipeline(cli, cfg);
    case "status":
      return await runStatus(cli, cfg);
    case "logs":
      return await runLogs(cli, cfg);
    case "clean":
      return await runClean(cli, cfg);
    default: {
      const _exhaustive: never = cli;
      throw new Error(`Unreachable: ${_exhaustive}`);
    }
  }
}

/**
 * Entry point — sets up SIGINT handler, parses CLI, dispatches.
 * Short-circuit order: help > init > doctor > load config > execute.
 * Exit 130 on interrupt (UNIX convention for SIGINT).
 */
async function main(): Promise<void> {
  let cli: CLI;
  try {
    cli = CLIParse(Deno.args);
  } catch (e) {
    $.logError((e as Error).message);
    Deno.exit(1);
  }

  // Short-circuit: help, version, init, doctor don't need config loaded
  if (cli.tag === "help") {
    $.log(USAGE);
    return;
  }

  if (cli.tag === "version") {
    $.log(`stress v${VERSION}`);
    return;
  }

  if (cli.tag === "init") {
    await runInit(cli);
    return;
  }

  if (cli.tag === "doctor") {
    await runDoctor(cli);
    return;
  }

  let cfg: Config;
  try {
    cfg = await loadConfig(cli.config);
  } catch (e) {
    $.logError((e as Error).message);
    Deno.exit(1);
  }

  Deno.addSignalListener("SIGINT", () => {
    if (interrupted) {
      Deno.exit(130);
    }
    interrupted = true;
    $.logWarn("\nInterrupted", "Ctrl+C received, cleaning up...");
    $.logWarn("", "Press Ctrl+C again to force quit.");
    abort.abort();
  });

  try {
    await execute(cli, cfg);
  } catch (e) {
    if (interrupted) Deno.exit(130);
    throw e;
  }
  if (interrupted) Deno.exit(130);
}

if (import.meta.main) {
  await main();
}
