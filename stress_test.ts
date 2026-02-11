/**
 * @module stress_test
 *
 * Tests for the exported API of stress.ts. Organized by function with
 * section separators (CLIParse, parseAwsEnv, detectAwsEnv, etc.).
 * Each section covers happy paths, edge cases, and error conditions.
 */
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  checkHelmCollisions,
  CLIParse,
  detectAwsEnv,
  interruptibleSleep,
  isPodReady,
  parseAwsEnv,
  parseConfig,
  parsePodStatus,
  pollUntil,
  redact,
} from "./stress.ts";

// ---------------------------------------------------------------------------
// CLIParse
// ---------------------------------------------------------------------------

Deno.test("CLIParse — mode=run with image-tag", () => {
  assertEquals(CLIParse(["--mode=run", "--image-tag=h69"]), {
    tag: "run",
    config: "stress.yaml",
    imageTag: "h69",
    dryRun: false,
  });
});

Deno.test("CLIParse — mode=run with image-tag and dry-run", () => {
  assertEquals(CLIParse(["--mode=run", "--image-tag=h69", "--dry-run"]), {
    tag: "run",
    config: "stress.yaml",
    imageTag: "h69",
    dryRun: true,
  });
});

Deno.test("CLIParse — mode=run with custom config", () => {
  assertEquals(
    CLIParse(["--mode=run", "--image-tag=h69", "--config=staging.yaml"]),
    {
      tag: "run",
      config: "staging.yaml",
      imageTag: "h69",
      dryRun: false,
    },
  );
});

Deno.test("CLIParse — mode=status", () => {
  assertEquals(CLIParse(["--mode=status"]), {
    tag: "status",
    config: "stress.yaml",
  });
});

Deno.test("CLIParse — mode=logs", () => {
  assertEquals(CLIParse(["--mode=logs"]), {
    tag: "logs",
    config: "stress.yaml",
  });
});

Deno.test("CLIParse — mode=run without image-tag throws", () => {
  assertThrows(
    () => CLIParse(["--mode=run"]),
    Error,
    "--image-tag is required for mode=run",
  );
});

Deno.test("CLIParse — no args returns help", () => {
  assertEquals(CLIParse([]), { tag: "help" });
});

Deno.test("CLIParse — --help returns help", () => {
  assertEquals(CLIParse(["--help"]), { tag: "help" });
});

Deno.test("CLIParse — --init returns init with default config", () => {
  assertEquals(CLIParse(["--init"]), {
    tag: "init",
    config: "stress.yaml",
  });
});

Deno.test("CLIParse — --init with custom config", () => {
  assertEquals(CLIParse(["--init", "--config=prod.yaml"]), {
    tag: "init",
    config: "prod.yaml",
  });
});

Deno.test("CLIParse — --doctor returns doctor with default config", () => {
  assertEquals(CLIParse(["--doctor"]), {
    tag: "doctor",
    config: "stress.yaml",
  });
});

Deno.test("CLIParse — --doctor with custom config", () => {
  assertEquals(CLIParse(["--doctor", "--config=staging.yaml"]), {
    tag: "doctor",
    config: "staging.yaml",
  });
});

Deno.test("CLIParse — unknown mode throws", () => {
  assertThrows(
    () => CLIParse(["--mode=deploy"]),
    Error,
    "Unknown mode: deploy",
  );
});

Deno.test("CLIParse — --version returns version", () => {
  assertEquals(CLIParse(["--version"]), { tag: "version" });
});

Deno.test("CLIParse — --version takes priority over --help", () => {
  assertEquals(CLIParse(["--version", "--help"]), { tag: "version" });
});

Deno.test("CLIParse — mode=clean", () => {
  assertEquals(CLIParse(["--mode=clean"]), {
    tag: "clean",
    config: "stress.yaml",
    dryRun: false,
  });
});

Deno.test("CLIParse — mode=clean with dry-run", () => {
  assertEquals(CLIParse(["--mode=clean", "--dry-run"]), {
    tag: "clean",
    config: "stress.yaml",
    dryRun: true,
  });
});

Deno.test("CLIParse — unknown flag throws", () => {
  assertThrows(
    () => CLIParse(["--mode=run", "--image-tag=abc", "--typo-flag"]),
    Error,
    "Unknown flag: --typo-flag",
  );
});

Deno.test("CLIParse — unexpected positional argument throws", () => {
  assertThrows(
    () => CLIParse(["--mode=run", "--image-tag=abc", "extra"]),
    Error,
    "Unexpected argument: extra",
  );
});

// ---------------------------------------------------------------------------
// parseAwsEnv
// ---------------------------------------------------------------------------

Deno.test("parseAwsEnv — extracts only AWS_* variables", () => {
  const raw = [
    "HOME=/Users/arnau",
    "PATH=/usr/bin:/bin",
    "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
    "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "AWS_SESSION_TOKEN=FwoGZXIvYXdzEA...",
    "SHELL=/bin/zsh",
    "AWS_REGION=us-east-1",
  ].join("\n");

  const result = parseAwsEnv(raw);

  assertEquals(result, {
    AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
    AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    AWS_SESSION_TOKEN: "FwoGZXIvYXdzEA...",
    AWS_REGION: "us-east-1",
  });
});

Deno.test("parseAwsEnv — handles values containing '='", () => {
  const raw = "AWS_SESSION_TOKEN=abc=def=ghi";

  const result = parseAwsEnv(raw);

  assertEquals(result, {
    AWS_SESSION_TOKEN: "abc=def=ghi",
  });
});

Deno.test("parseAwsEnv — empty input returns empty object", () => {
  assertEquals(parseAwsEnv(""), {});
});

Deno.test("parseAwsEnv — no AWS vars returns empty object", () => {
  const raw = [
    "HOME=/Users/arnau",
    "PATH=/usr/bin:/bin",
    "SHELL=/bin/zsh",
  ].join("\n");

  assertEquals(parseAwsEnv(raw), {});
});

Deno.test("parseAwsEnv — lines without '=' are skipped", () => {
  const raw = "AWS_BROKEN\nAWS_REGION=us-east-1\n=no-key";
  assertEquals(parseAwsEnv(raw), { AWS_REGION: "us-east-1" });
});

// ---------------------------------------------------------------------------
// detectAwsEnv
// ---------------------------------------------------------------------------

Deno.test("detectAwsEnv — all 3 required vars present returns 'found' with all AWS_* vars", () => {
  const env = {
    HOME: "/Users/arnau",
    AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
    AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    AWS_SESSION_TOKEN: "FwoGZXIvYXdzEA...",
    AWS_REGION: "us-east-1",
    SHELL: "/bin/zsh",
  };

  const result = detectAwsEnv(env);
  assertEquals(result, {
    tag: "found",
    env: {
      AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      AWS_SESSION_TOKEN: "FwoGZXIvYXdzEA...",
      AWS_REGION: "us-east-1",
    },
  });
});

Deno.test("detectAwsEnv — missing one required var returns 'partial'", () => {
  const env = {
    AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
    AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  };

  const result = detectAwsEnv(env);
  assertEquals(result, {
    tag: "partial",
    found: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
    missing: ["AWS_SESSION_TOKEN"],
  });
});

Deno.test("detectAwsEnv — no AWS vars at all returns 'none'", () => {
  const env = {
    HOME: "/Users/arnau",
    SHELL: "/bin/zsh",
  };

  assertEquals(detectAwsEnv(env), { tag: "none" });
});

Deno.test("detectAwsEnv — empty env returns 'none'", () => {
  assertEquals(detectAwsEnv({}), { tag: "none" });
});

Deno.test("detectAwsEnv — empty string values treated as missing", () => {
  const env = {
    AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
    AWS_SECRET_ACCESS_KEY: "",
    AWS_SESSION_TOKEN: "FwoGZXIvYXdzEA...",
  };

  const result = detectAwsEnv(env);
  assertEquals(result, {
    tag: "partial",
    found: ["AWS_ACCESS_KEY_ID", "AWS_SESSION_TOKEN"],
    missing: ["AWS_SECRET_ACCESS_KEY"],
  });
});

// ---------------------------------------------------------------------------
// redact
// ---------------------------------------------------------------------------

Deno.test("redact — sensitive var shows first 4 chars + ****", () => {
  assertEquals(redact("AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE"), "AKIA****");
});

Deno.test("redact — short sensitive value shows only ****", () => {
  assertEquals(redact("AWS_SESSION_TOKEN", "abc"), "****");
});

Deno.test("redact — non-sensitive var shows full value", () => {
  assertEquals(redact("AWS_REGION", "us-east-1"), "us-east-1");
});

Deno.test("redact — exactly 4-char sensitive value shows only ****", () => {
  assertEquals(redact("AWS_ACCESS_KEY_ID", "AKIA"), "****");
});

// ---------------------------------------------------------------------------
// parsePodStatus
// ---------------------------------------------------------------------------

Deno.test("parsePodStatus — parses normal kubectl line", () => {
  assertEquals(
    parsePodStatus("heimdall-load-test-runner-qrqkg   1/1   Running   0   55s"),
    { name: "heimdall-load-test-runner-qrqkg", status: "Running" },
  );
});

Deno.test("parsePodStatus — parses Init status", () => {
  assertEquals(
    parsePodStatus(
      "heimdall-load-test-runner-qrqkg   0/1   Init:0/1   0   10s",
    ),
    { name: "heimdall-load-test-runner-qrqkg", status: "Init:0/1" },
  );
});

Deno.test("parsePodStatus — returns null for empty line", () => {
  assertEquals(parsePodStatus(""), null);
  assertEquals(parsePodStatus("   "), null);
});

Deno.test("parsePodStatus — handles variable whitespace alignment", () => {
  assertEquals(
    parsePodStatus("pod-abc   0/1     ContainerCreating     0          3s"),
    { name: "pod-abc", status: "ContainerCreating" },
  );
});

Deno.test("parsePodStatus — returns null for line with fewer than 3 columns", () => {
  assertEquals(parsePodStatus("pod-name  1/1"), null);
});

// ---------------------------------------------------------------------------
// isPodReady
// ---------------------------------------------------------------------------

Deno.test("isPodReady — Running is ready", () => {
  assertEquals(isPodReady("Running"), true);
});

Deno.test("isPodReady — Completed is ready", () => {
  assertEquals(isPodReady("Completed"), true);
});

Deno.test("isPodReady — CrashLoopBackOff is ready (logs are streamable)", () => {
  assertEquals(isPodReady("CrashLoopBackOff"), true);
});

Deno.test("isPodReady — ContainerCreating is not ready", () => {
  assertEquals(isPodReady("ContainerCreating"), false);
});

Deno.test("isPodReady — PodInitializing is not ready", () => {
  assertEquals(isPodReady("PodInitializing"), false);
});

Deno.test("isPodReady — Pending is not ready", () => {
  assertEquals(isPodReady("Pending"), false);
});

Deno.test("isPodReady — Init:0/1 is not ready", () => {
  assertEquals(isPodReady("Init:0/1"), false);
});

Deno.test("isPodReady — Error is ready (logs are streamable)", () => {
  assertEquals(isPodReady("Error"), true);
});

// ---------------------------------------------------------------------------
// interruptibleSleep
// ---------------------------------------------------------------------------

Deno.test("interruptibleSleep — resolves 'timeout' after delay", async () => {
  const ac = new AbortController();
  const start = Date.now();
  const result = await interruptibleSleep(50, ac.signal);
  const elapsed = Date.now() - start;

  assertEquals(result, "timeout");
  assertEquals(elapsed >= 40, true, `expected ~50ms, got ${elapsed}ms`);
});

Deno.test("interruptibleSleep — resolves 'aborted' immediately when pre-aborted", async () => {
  const ac = new AbortController();
  ac.abort();

  const start = Date.now();
  const result = await interruptibleSleep(5000, ac.signal);
  const elapsed = Date.now() - start;

  assertEquals(result, "aborted");
  assertEquals(elapsed < 50, true, `expected immediate, got ${elapsed}ms`);
});

Deno.test("interruptibleSleep — resolves 'aborted' on mid-sleep abort", async () => {
  const ac = new AbortController();
  const start = Date.now();

  setTimeout(() => ac.abort(), 30);
  const result = await interruptibleSleep(5000, ac.signal);
  const elapsed = Date.now() - start;

  assertEquals(result, "aborted");
  assertEquals(elapsed < 200, true, `expected ~30ms, got ${elapsed}ms`);
  assertEquals(elapsed >= 20, true, `expected at least 20ms, got ${elapsed}ms`);
});

// ---------------------------------------------------------------------------
// pollUntil
// ---------------------------------------------------------------------------

Deno.test("pollUntil — returns true when fn succeeds", async () => {
  let calls = 0;
  const ac = new AbortController();

  const result = await pollUntil(
    () => {
      calls++;
      return Promise.resolve(calls >= 3);
    },
    20,
    ac.signal,
  );

  assertEquals(result, true);
  assertEquals(calls, 3);
});

Deno.test("pollUntil — returns false when aborted mid-poll", async () => {
  let calls = 0;
  const ac = new AbortController();

  // Abort after ~70ms — fn should be called a few times (interval 30ms)
  setTimeout(() => ac.abort(), 70);

  const result = await pollUntil(
    () => {
      calls++;
      return Promise.resolve(false); // never succeeds
    },
    30,
    ac.signal,
  );

  assertEquals(result, false);
  assertEquals(calls >= 1, true, `expected at least 1 call, got ${calls}`);
});

Deno.test("pollUntil — returns false when signal already aborted", async () => {
  let calls = 0;
  const ac = new AbortController();
  ac.abort();

  const result = await pollUntil(
    () => {
      calls++;
      return Promise.resolve(true);
    },
    20,
    ac.signal,
  );

  assertEquals(result, false);
  assertEquals(calls, 0);
});

Deno.test("pollUntil — waits interval between polls", async () => {
  let calls = 0;
  const ac = new AbortController();
  const start = Date.now();

  const result = await pollUntil(
    () => {
      calls++;
      return Promise.resolve(calls >= 2); // succeeds on 2nd call
    },
    50,
    ac.signal,
  );
  const elapsed = Date.now() - start;

  assertEquals(result, true);
  assertEquals(calls, 2);
  // Should have waited ~50ms (one interval between call 1 and call 2)
  assertEquals(elapsed >= 40, true, `expected ~50ms wait, got ${elapsed}ms`);
});

Deno.test("pollUntil — returns false when maxMs exceeded", async () => {
  let calls = 0;
  const ac = new AbortController();
  const start = Date.now();

  const result = await pollUntil(
    () => {
      calls++;
      return Promise.resolve(false); // never succeeds
    },
    30,
    ac.signal,
    80,
  );
  const elapsed = Date.now() - start;

  assertEquals(result, false);
  assertEquals(calls >= 1, true, `expected at least 1 call, got ${calls}`);
  assertEquals(elapsed < 300, true, `expected <300ms, got ${elapsed}ms`);
});

Deno.test("pollUntil — propagates error when fn throws", async () => {
  const ac = new AbortController();
  await assertRejects(
    () =>
      pollUntil(
        () => Promise.reject(new Error("boom")),
        20,
        ac.signal,
      ),
    Error,
    "boom",
  );
});

// ---------------------------------------------------------------------------
// parseConfig
// ---------------------------------------------------------------------------

const VALID_CONFIG = {
  profile: "analytics-dev",
  cluster: "analytics",
  region: "us-east-1",
  namespace: "load-test",
  release: "heimdall-load-test",
  chart: "playgami-load-testing/load-test",
  simulation: "com.scopely.heimdall.loadtest.smoke.SmokeSimulation",
  image: "heimdall-load-test",
  repository: "scopelybin-docker.jfrog.io/satellites-snapshots",
};

Deno.test("parseConfig — valid config with all required fields", () => {
  const cfg = parseConfig(VALID_CONFIG);
  assertEquals(cfg.profile, "analytics-dev");
  assertEquals(cfg.cluster, "analytics");
  assertEquals(cfg.namespace, "load-test");
});

Deno.test("parseConfig — missing required field throws listing the field", () => {
  const { profile: _, ...rest } = VALID_CONFIG;
  assertThrows(
    () => parseConfig(rest),
    Error,
    "profile",
  );
});

Deno.test("parseConfig — multiple missing fields lists all", () => {
  const { profile: _p, cluster: _c, namespace: _n, ...rest } = VALID_CONFIG;
  assertThrows(
    () => parseConfig(rest),
    Error,
    "profile",
  );
  assertThrows(
    () => parseConfig(rest),
    Error,
    "cluster",
  );
  assertThrows(
    () => parseConfig(rest),
    Error,
    "namespace",
  );
});

Deno.test("parseConfig — empty string value treated as missing", () => {
  assertThrows(
    () => parseConfig({ ...VALID_CONFIG, profile: "" }),
    Error,
    "profile",
  );
});

Deno.test("parseConfig — non-object input throws", () => {
  assertThrows(() => parseConfig(null), Error, "YAML mapping");
  assertThrows(() => parseConfig("string"), Error, "YAML mapping");
  assertThrows(() => parseConfig(42), Error, "YAML mapping");
  assertThrows(() => parseConfig([]), Error, "YAML mapping");
});

Deno.test("parseConfig — helm block is optional, defaults to null", () => {
  const cfg = parseConfig(VALID_CONFIG);
  assertEquals(cfg.helm, null);
});

Deno.test("parseConfig — helm block is passed through when present", () => {
  const helm = {
    gatling: { parallelism: 2 },
    resources: { requests: { cpu: "4" } },
  };
  const cfg = parseConfig({ ...VALID_CONFIG, helm });
  assertEquals(cfg.helm, helm);
});

Deno.test("parseConfig — helm block must be object if present", () => {
  assertThrows(
    () => parseConfig({ ...VALID_CONFIG, helm: "not-an-object" }),
    Error,
    "helm",
  );
  assertThrows(
    () => parseConfig({ ...VALID_CONFIG, helm: ["array"] }),
    Error,
    "helm",
  );
});

Deno.test("parseConfig — pod_timeout defaults to 600 when absent", () => {
  const cfg = parseConfig(VALID_CONFIG);
  assertEquals(cfg.pod_timeout, 600);
});

Deno.test("parseConfig — pod_timeout accepts positive number", () => {
  const cfg = parseConfig({ ...VALID_CONFIG, pod_timeout: 300 });
  assertEquals(cfg.pod_timeout, 300);
});

Deno.test("parseConfig — pod_timeout must be positive number", () => {
  assertThrows(
    () => parseConfig({ ...VALID_CONFIG, pod_timeout: "abc" }),
    Error,
    "pod_timeout",
  );
  assertThrows(
    () => parseConfig({ ...VALID_CONFIG, pod_timeout: -1 }),
    Error,
    "pod_timeout",
  );
  assertThrows(
    () => parseConfig({ ...VALID_CONFIG, pod_timeout: 0 }),
    Error,
    "pod_timeout",
  );
});

Deno.test("parseConfig — wrong-type field reported as invalid not missing", () => {
  assertThrows(
    () => parseConfig({ ...VALID_CONFIG, region: 1 }),
    Error,
    "invalid fields: region (must be a string, got number)",
  );
});

Deno.test("parseConfig — multiple wrong-type fields lists all as invalid", () => {
  assertThrows(
    () => parseConfig({ ...VALID_CONFIG, cluster: true, namespace: [1, 2] }),
    Error,
    "invalid fields: cluster (must be a string, got boolean), namespace (must be a string, got object)",
  );
});

// ---------------------------------------------------------------------------
// checkHelmCollisions
// ---------------------------------------------------------------------------

Deno.test("checkHelmCollisions — no collisions returns empty", () => {
  const helm = {
    gatling: { parallelism: 2 },
    resources: { requests: { cpu: "4" } },
  };
  assertEquals(checkHelmCollisions(helm), []);
});

Deno.test("checkHelmCollisions — detects nested collision", () => {
  const helm = {
    gatling: { image: { name: "override" } },
  };
  assertEquals(checkHelmCollisions(helm), ["gatling.image.name"]);
});

Deno.test("checkHelmCollisions — detects multiple collisions", () => {
  const helm = {
    gatling: {
      cluster_name: "wrong",
      simulationClass: "wrong",
      image: { name: "wrong", repository: "wrong" },
    },
  };
  assertEquals(checkHelmCollisions(helm).sort(), [
    "gatling.cluster_name",
    "gatling.image.name",
    "gatling.image.repository",
    "gatling.simulationClass",
  ]);
});
