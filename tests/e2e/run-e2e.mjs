import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLAYWRIGHT_BROWSERS_PATH = '/opt/ms-playwright';
const VALID_TIERS = new Set(['1', '2', '3', '4', 'all']);
const E2E_FILE_RE = /\.e2e\.test\.mjs$/;

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function asciiCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function formatUsage() {
  return [
    'Usage: node tests/e2e/run-e2e.mjs [options]',
    '',
    'Options:',
    '  --tier=1|2|3|4|all         Run specific tier or all tiers sequentially (default: all)',
    '  --filter=<substring>       Filter by filename substring, or fallback to test title match',
    '  --grep=<pattern>           Explicit --test-name-pattern passed to node --test',
    '  --list                     List discovered matching test files without executing',
    '  --selftest                 Run harness-selftest.mjs with recursion protection',
    '  --base-url=<url>           Target an already-running server (sets E2E_BASE_URL)',
    '  --root=<dir>               Override E2E root directory (default: tests/e2e)',
    '  -h, --help                 Show this help message',
  ].join('\n');
}

export function parseCliArgs(argv = []) {
  const args = {
    tier: null,
    tierExplicit: false,
    filter: null,
    grep: null,
    list: false,
    selftest: false,
    baseUrl: null,
    root: null,
    rootExplicit: false,
    help: false,
    error: null,
  };

  const fail = (msg) => {
    args.error = msg;
    return args;
  };

  const readOptionValue = (token, idx, flagName) => {
    const eqIdx = token.indexOf('=');
    if (eqIdx !== -1) {
      const val = token.slice(eqIdx + 1);
      return { value: val, nextIdx: idx };
    }
    if (idx + 1 >= argv.length) {
      return { error: `Missing value for ${flagName}`, nextIdx: idx };
    }
    const nextVal = argv[idx + 1];
    if (nextVal.startsWith('-')) {
      return { error: `Missing value for ${flagName}`, nextIdx: idx };
    }
    return { value: nextVal, nextIdx: idx + 1 };
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }

    if (token === '--list') {
      args.list = true;
      continue;
    }

    if (token === '--selftest') {
      args.selftest = true;
      continue;
    }

    if (token === '--tier' || token.startsWith('--tier=')) {
      const res = readOptionValue(token, i, '--tier');
      if (res.error) return fail(res.error);
      i = res.nextIdx;
      const val = res.value.trim();
      if (!VALID_TIERS.has(val)) {
        return fail(`Invalid --tier value "${res.value}". Expected one of: 1, 2, 3, 4, all.`);
      }
      args.tier = val;
      args.tierExplicit = true;
      continue;
    }

    if (token === '--filter' || token.startsWith('--filter=')) {
      const res = readOptionValue(token, i, '--filter');
      if (res.error) return fail(res.error);
      i = res.nextIdx;
      if (!res.value || res.value.trim() === '') {
        return fail('Invalid --filter value: must be a non-empty substring.');
      }
      args.filter = res.value;
      continue;
    }

    if (
      token === '--grep' ||
      token.startsWith('--grep=') ||
      token === '--test-name-pattern' ||
      token.startsWith('--test-name-pattern=')
    ) {
      const flagName = token.startsWith('--grep') ? '--grep' : '--test-name-pattern';
      const res = readOptionValue(token, i, flagName);
      if (res.error) return fail(res.error);
      i = res.nextIdx;
      if (!res.value || res.value.trim() === '') {
        return fail(`Invalid ${flagName} value: must be non-empty.`);
      }
      args.grep = res.value;
      continue;
    }

    if (token === '--base-url' || token.startsWith('--base-url=')) {
      const res = readOptionValue(token, i, '--base-url');
      if (res.error) return fail(res.error);
      i = res.nextIdx;
      const rawUrl = res.value.trim();
      let parsed;
      try {
        parsed = new URL(rawUrl);
      } catch {
        return fail(`Invalid --base-url value "${res.value}": must be a valid http(s) URL.`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return fail(`Invalid --base-url protocol "${parsed.protocol}": expected http: or https:.`);
      }
      args.baseUrl = rawUrl.replace(/\/+$/, '');
      continue;
    }

    if (token === '--root' || token.startsWith('--root=')) {
      const res = readOptionValue(token, i, '--root');
      if (res.error) return fail(res.error);
      i = res.nextIdx;
      if (!res.value || res.value.trim() === '') {
        return fail('Invalid --root value: must be a non-empty directory path.');
      }
      args.root = path.resolve(res.value);
      args.rootExplicit = true;
      continue;
    }

    return fail(`Unknown argument: ${token}`);
  }

  if (args.help) return args;

  if (args.selftest && args.tierExplicit) {
    return fail('Cannot combine --selftest with --tier.');
  }

  if (!args.selftest && !args.tier) {
    args.tier = 'all';
  }

  return args;
}

export function discoverTierFiles(e2eRoot, tiers = [1, 2, 3, 4]) {
  const result = {};
  for (const tier of tiers) {
    const tierDir = path.join(e2eRoot, `tier${tier}`);
    if (!fs.existsSync(tierDir)) {
      result[tier] = [];
      continue;
    }
    let entries;
    try {
      entries = fs.readdirSync(tierDir, { withFileTypes: true });
    } catch {
      result[tier] = [];
      continue;
    }
    const filenames = entries
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && E2E_FILE_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort(asciiCompare);

    result[tier] = filenames.map((filename) => ({
      tier,
      filename,
      relPath: `tier${tier}/${filename}`,
      absPath: path.join(tierDir, filename),
    }));
  }
  return result;
}

export function parseTapSummary(tapText, { filePaths = [] } = {}) {
  const lines = String(tapText || '').split(/\r?\n/);

  // Step A: Locate the LAST top-level plan line (^1..\d+$) so console.log('pass 999')
  // inside test bodies can never spoof TAP summary directives.
  let lastPlanIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^1\.\.\d+$/.test(lines[i])) {
      lastPlanIdx = i;
      break;
    }
  }

  let tests = 0;
  let suites = 0;
  let pass = 0;
  let fail = 0;
  let cancelled = 0;
  let skipped = 0;
  let todo = 0;
  let durationMs = 0;
  let sawTestsLine = false;

  if (lastPlanIdx !== -1) {
    for (let i = lastPlanIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      let m;
      if ((m = line.match(/^# tests (\d+)$/))) {
        tests = Number(m[1]);
        sawTestsLine = true;
      } else if ((m = line.match(/^# suites (\d+)$/))) {
        suites = Number(m[1]);
      } else if ((m = line.match(/^# pass (\d+)$/))) {
        pass = Number(m[1]);
      } else if ((m = line.match(/^# fail (\d+)$/))) {
        fail = Number(m[1]);
      } else if ((m = line.match(/^# cancelled (\d+)$/))) {
        cancelled = Number(m[1]);
      } else if ((m = line.match(/^# skipped (\d+)$/))) {
        skipped = Number(m[1]);
      } else if ((m = line.match(/^# todo (\d+)$/))) {
        todo = Number(m[1]);
      } else if ((m = line.match(/^# duration_ms ([0-9.]+)$/))) {
        durationMs = Number(m[1]);
      }
    }
  }

  // Step B: Detect Node 22 synthetic file-level passes emitted when a test file
  // executes 0 tests (whether via --test-name-pattern with a preceding `1..0`, an
  // empty 0-test .e2e.test.mjs file without `1..0`, or an abrupt process.exit(0)
  // mid-test):
  //   # Subtest: /abs/path/to/file.mjs
  //   ok <N> - /abs/path/to/file.mjs
  const knownFiles = new Set();
  for (const fp of filePaths) {
    knownFiles.add(fp);
    knownFiles.add(path.resolve(fp));
    const rel = path.relative(process.cwd(), fp);
    if (rel) knownFiles.add(rel);
  }

  let emptyFiles = 0;
  const emptyFilePaths = [];
  const scanEnd = lastPlanIdx === -1 ? lines.length : lastPlanIdx;
  for (let i = 0; i + 1 < scanEnd; i++) {
    const subMatch = lines[i].match(/^# Subtest: (.+)$/);
    if (!subMatch) continue;
    const okMatch = lines[i + 1].match(/^ok \d+ - (.+)$/);
    if (!okMatch) continue;
    const subName = subMatch[1];
    const okName = okMatch[1];
    if (subName !== okName) continue;
    const matchesKnown =
      knownFiles.size > 0
        ? knownFiles.has(subName) || knownFiles.has(path.resolve(subName))
        : /\.(m?js|cjs)$/.test(subName);
    if (matchesKnown) {
      emptyFiles++;
      emptyFilePaths.push(subName);
      i++;
    }
  }

  const adjustedTests = Math.max(0, tests - emptyFiles);
  const adjustedPass = Math.max(0, pass - emptyFiles);

  return {
    parsed: lastPlanIdx !== -1 && sawTestsLine,
    tests: adjustedTests,
    suites,
    pass: adjustedPass,
    fail,
    cancelled,
    skipped,
    todo,
    durationMs,
    emptyFiles,
    emptyFilePaths,
    rawTests: tests,
    rawPass: pass,
  };
}

function evaluateRunPass({ exitCode, signal, summary, hasPatternFilter = false }) {
  return (
    exitCode === 0 &&
    signal === null &&
    summary.parsed &&
    summary.tests > 0 &&
    summary.fail === 0 &&
    summary.cancelled === 0 &&
    summary.skipped === 0 &&
    summary.todo === 0 &&
    summary.pass === summary.tests &&
    (hasPatternFilter || summary.emptyFiles === 0)
  );
}

async function runNodeTestBatch({ label, filePaths, testNamePattern, env }) {
  const tapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-tap-'));
  const tapFile = path.join(tapDir, `${label.replace(/[^a-z0-9_-]/gi, '_')}.tap`);
  const startedAt = Date.now();

  const nodeArgs = [
    '--test',
    '--test-concurrency=1',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=tap',
    `--test-reporter-destination=${tapFile}`,
  ];
  if (testNamePattern) {
    nodeArgs.push(`--test-name-pattern=${testNamePattern}`);
  }
  nodeArgs.push(...filePaths);

  try {
    const { exitCode, signal } = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, nodeArgs, {
        env,
        stdio: 'inherit',
      });

      const forwardSignal = (sig) => {
        try {
          child.kill(sig);
        } catch {
          // Child may have already exited
        }
      };
      process.on('SIGINT', forwardSignal);
      process.on('SIGTERM', forwardSignal);

      const cleanupListeners = () => {
        process.off('SIGINT', forwardSignal);
        process.off('SIGTERM', forwardSignal);
      };

      child.once('error', (err) => {
        cleanupListeners();
        reject(err);
      });

      child.once('exit', (code, sig) => {
        cleanupListeners();
        resolve({ exitCode: code, signal: sig });
      });
    });

    const elapsedMs = Date.now() - startedAt;
    const tapText = fs.existsSync(tapFile) ? fs.readFileSync(tapFile, 'utf8') : '';
    const summary = parseTapSummary(tapText, { filePaths });
    const hasPatternFilter = Boolean(testNamePattern);
    const passed = evaluateRunPass({ exitCode, signal, summary, hasPatternFilter });

    // Never display fail=0 on non-zero exit/crash or unfiltered empty/aborted test files.
    let reportedFail = summary.fail;
    if (!hasPatternFilter && summary.emptyFiles > 0) {
      reportedFail = Math.max(reportedFail, summary.emptyFiles);
      const filesNote =
        summary.emptyFilePaths.length > 0 ? `: ${summary.emptyFilePaths.join(', ')}` : '';
      console.error(
        `[run-e2e] ${label}: ${summary.emptyFiles} empty or prematurely exited test file(s) executed 0 tests${filesNote}`
      );
    } else if (!passed && exitCode !== 0 && summary.fail === 0 && summary.cancelled === 0) {
      reportedFail = 1;
    }

    return {
      passed,
      exitCode,
      signal,
      elapsedMs,
      summary: {
        ...summary,
        fail: reportedFail,
      },
    };
  } finally {
    fs.rmSync(tapDir, { recursive: true, force: true });
  }
}

function buildChildEnv(baseUrl, extraEnv = {}) {
  const env = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH:
      process.env.PLAYWRIGHT_BROWSERS_PATH || DEFAULT_PLAYWRIGHT_BROWSERS_PATH,
    ...(baseUrl ? { E2E_BASE_URL: baseUrl } : {}),
    ...extraEnv,
  };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function formatSummaryRow(label, status, s, elapsedMs) {
  const dur = Math.round(s.durationMs || elapsedMs || 0);
  return (
    `${label}: ${status.padEnd(4)}  ` +
    `tests=${s.tests}  pass=${s.pass}  fail=${s.fail}  ` +
    `cancelled=${s.cancelled}  skipped=${s.skipped}  todo=${s.todo}  (${dur}ms)`
  );
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);

  if (args.error) {
    console.error(`[run-e2e] Error: ${args.error}`);
    console.error(formatUsage());
    return 2;
  }

  if (args.help) {
    console.log(formatUsage());
    return 0;
  }

  // --------------------------------------------------------------------------
  // Mode 1: --selftest (with target-tracking + active-flag recursion guard)
  // --------------------------------------------------------------------------
  if (args.selftest) {
    const envSelftestFile = process.env.E2E_SELFTEST_FILE?.trim() || '';
    const envTestRoot = process.env.E2E_TEST_ROOT?.trim() || '';

    let resolvedSelftest;
    if (args.rootExplicit) {
      resolvedSelftest = path.resolve(args.root, 'harness-selftest.mjs');
    } else if (envSelftestFile) {
      resolvedSelftest = path.resolve(envSelftestFile);
    } else if (envTestRoot) {
      resolvedSelftest = path.resolve(envTestRoot, 'harness-selftest.mjs');
    } else {
      resolvedSelftest = path.join(THIS_DIR, 'harness-selftest.mjs');
    }

    const activeTargets = new Set(
      (process.env.E2E_SELFTEST_TARGETS || '')
        .split(path.delimiter)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => path.resolve(p))
    );

    const sameTargetRecursion = activeTargets.has(resolvedSelftest);
    const implicitActiveRecursion =
      process.env.E2E_SELFTEST_ACTIVE === '1' && !args.rootExplicit && !envSelftestFile;

    if (sameTargetRecursion || implicitActiveRecursion) {
      console.error(
        `[run-e2e] Recursive --selftest detected for ${resolvedSelftest}; refusing to spawn infinite loop.`
      );
      return 2;
    }

    if (!fs.existsSync(resolvedSelftest)) {
      console.error(`[run-e2e] Selftest file not found: ${resolvedSelftest}`);
      return 1;
    }

    if (args.list) {
      console.log(`Selftest:\n  ${resolvedSelftest}`);
      return 0;
    }

    const nextTargets = new Set(activeTargets);
    nextTargets.add(resolvedSelftest);

    const pattern =
      args.grep || (args.filter ? `/${escapeRegExp(args.filter)}/i` : null);

    console.log(`=== Running E2E Selftest: ${resolvedSelftest} ===`);
    const result = await runNodeTestBatch({
      label: 'selftest',
      filePaths: [resolvedSelftest],
      testNamePattern: pattern,
      env: buildChildEnv(args.baseUrl, {
        E2E_SELFTEST_ACTIVE: '1',
        E2E_SELFTEST_TARGETS: [...nextTargets].join(path.delimiter),
      }),
    });

    console.log('\n=== E2E Selftest Summary ===');
    console.log(
      formatSummaryRow(
        'Selftest',
        result.passed ? 'PASS' : 'FAIL',
        result.summary,
        result.elapsedMs
      )
    );
    return result.passed ? 0 : 1;
  }

  // --------------------------------------------------------------------------
  // Mode 2: Standard Tier Runner (--tier=1|2|3|4|all)
  // --------------------------------------------------------------------------
  const e2eRoot = args.rootExplicit
    ? args.root
    : process.env.E2E_TEST_ROOT?.trim()
      ? path.resolve(process.env.E2E_TEST_ROOT.trim())
      : THIS_DIR;

  const tiers = args.tier === 'all' ? [1, 2, 3, 4] : [Number(args.tier)];
  const discoveredByTier = discoverTierFiles(e2eRoot, tiers);

  let selectedByTier = discoveredByTier;
  let filterPattern = args.grep || null;
  let filterMode = 'none';

  if (args.filter) {
    const needle = args.filter.toLowerCase();

    // Pass 1: Filename / relative path substring match
    const fileMatchedByTier = {};
    let fileMatchCount = 0;
    for (const tier of tiers) {
      const matched = discoveredByTier[tier].filter((f) =>
        f.relPath.toLowerCase().includes(needle)
      );
      fileMatchedByTier[tier] = matched;
      fileMatchCount += matched.length;
    }

    if (fileMatchCount > 0) {
      selectedByTier = fileMatchedByTier;
      filterMode = 'file';
    } else if (args.list) {
      // Pass 2 (--list only): Pre-scan file contents since tests are not executed in --list mode.
      const contentMatchedByTier = {};
      let contentMatchCount = 0;
      for (const tier of tiers) {
        const matched = [];
        for (const f of discoveredByTier[tier]) {
          try {
            const src = fs.readFileSync(f.absPath, 'utf8');
            if (src.toLowerCase().includes(needle)) {
              matched.push(f);
            }
          } catch {
            // Skip unreadable file
          }
        }
        contentMatchedByTier[tier] = matched;
        contentMatchCount += matched.length;
      }

      if (contentMatchCount > 0) {
        selectedByTier = contentMatchedByTier;
        filterMode = 'title';
      } else {
        console.error(`[run-e2e] No test files or tests matched --filter="${args.filter}".`);
        return 1;
      }
    } else {
      // Execution mode: Pass 1 yielded 0 filename matches -> run all discovered tier files with
      // --test-name-pattern (matching --grep behavior) so dynamic template-literal or JS-escaped
      // test titles are never silently dropped by raw-source pre-scanning.
      const totalDiscovered = tiers.reduce((sum, t) => sum + discoveredByTier[t].length, 0);
      if (totalDiscovered === 0) {
        console.error('[run-e2e] No test files found in requested tier(s).');
        return 1;
      }
      filterMode = 'test-name';
      if (!filterPattern) {
        filterPattern = `/${escapeRegExp(args.filter)}/i`;
      }
      selectedByTier = discoveredByTier;
    }
  }

  // --list mode: display discovered matching files without running them.
  if (args.list) {
    let totalFiles = 0;
    let missingRequiredTier = false;
    for (const tier of tiers) {
      const files = selectedByTier[tier];
      totalFiles += files.length;
      console.log(`Tier ${tier} (${files.length} file${files.length === 1 ? '' : 's'}):`);
      if (files.length === 0) {
        if (!args.filter && !args.grep) {
          missingRequiredTier = true;
          console.log('  (no test files found)');
        } else {
          console.log('  (0 matched by filter)');
        }
      } else {
        for (const f of files) {
          const suffix =
            filterMode === 'title'
              ? ' (matched in source; will run with --test-name-pattern)'
              : '';
          console.log(`  ${f.relPath}${suffix}`);
        }
      }
    }
    if (totalFiles === 0 || missingRequiredTier) {
      console.error('[run-e2e] No matching test files found for requested tier(s).');
      return 1;
    }
    return 0;
  }

  // Sequential tier execution.
  const childEnv = buildChildEnv(args.baseUrl);
  const tierResults = [];
  const totals = {
    tests: 0,
    pass: 0,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    durationMs: 0,
  };
  let anyTierFailed = false;

  for (const tier of tiers) {
    const files = selectedByTier[tier];
    if (files.length === 0) {
      if (args.filter || args.grep) {
        tierResults.push({
          tier,
          status: 'FILTERED',
          skippedByFilter: true,
          summary: { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0, durationMs: 0 },
          elapsedMs: 0,
        });
        continue;
      }
      console.error(`[run-e2e] Tier ${tier}: no *.e2e.test.mjs files found under ${path.join(e2eRoot, `tier${tier}`)}`);
      anyTierFailed = true;
      tierResults.push({
        tier,
        status: 'FAIL',
        skippedByFilter: false,
        summary: { tests: 0, pass: 0, fail: 1, cancelled: 0, skipped: 0, todo: 0, durationMs: 0 },
        elapsedMs: 0,
      });
      totals.fail += 1;
      continue;
    }

    console.log(
      `\n=== Running Tier ${tier} (${files.length} file${files.length === 1 ? '' : 's'}) ===`
    );
    const res = await runNodeTestBatch({
      label: `tier${tier}`,
      filePaths: files.map((f) => f.absPath),
      testNamePattern: filterPattern,
      env: childEnv,
    });

    // Under multi-tier --filter/--grep, a candidate file whose source contained the needle
    // only in a comment produces adjusted tests=0 with exitCode=0; treat that tier as 0 matched
    // (overall still fails if total tests across all tiers is 0, or if single tier was requested).
    const zeroMatchedOnly =
      Boolean(filterPattern) &&
      res.exitCode === 0 &&
      res.signal === null &&
      res.summary.parsed &&
      res.summary.tests === 0 &&
      res.summary.fail === 0 &&
      res.summary.cancelled === 0 &&
      res.summary.skipped === 0 &&
      res.summary.todo === 0;

    if (zeroMatchedOnly && tiers.length > 1) {
      tierResults.push({
        tier,
        status: 'FILTERED',
        skippedByFilter: true,
        summary: res.summary,
        elapsedMs: res.elapsedMs,
      });
      continue;
    }

    if (!res.passed) {
      anyTierFailed = true;
    }

    tierResults.push({
      tier,
      status: res.passed ? 'PASS' : 'FAIL',
      skippedByFilter: false,
      summary: res.summary,
      elapsedMs: res.elapsedMs,
    });

    totals.tests += res.summary.tests;
    totals.pass += res.summary.pass;
    totals.fail += res.summary.fail;
    totals.cancelled += res.summary.cancelled;
    totals.skipped += res.summary.skipped;
    totals.todo += res.summary.todo;
    totals.durationMs += res.summary.durationMs || res.elapsedMs;
  }

  const overallPassed =
    !anyTierFailed &&
    totals.tests > 0 &&
    totals.fail === 0 &&
    totals.cancelled === 0 &&
    totals.skipped === 0 &&
    totals.todo === 0 &&
    totals.pass === totals.tests;

  console.log('\n=== E2E Summary ===');
  for (const r of tierResults) {
    if (r.skippedByFilter) {
      console.log(`Tier ${r.tier}: 0 matched (filtered)`);
    } else {
      console.log(formatSummaryRow(`Tier ${r.tier}`, r.status, r.summary, r.elapsedMs));
    }
  }
  console.log(
    `OVERALL: ${overallPassed ? 'PASS' : 'FAIL'}  ` +
      `tests=${totals.tests}  pass=${totals.pass}  fail=${totals.fail}  ` +
      `cancelled=${totals.cancelled}  skipped=${totals.skipped}  todo=${totals.todo}`
  );

  if (totals.tests === 0) {
    console.error('[run-e2e] Zero tests matched and executed.');
  }

  return overallPassed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error('[run-e2e] Unhandled runner error:', err);
      process.exitCode = 1;
    });
}
