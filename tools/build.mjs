#!/usr/bin/env node
/**
 * Home Pharmacy Build & Privacy/Secret Check Pipeline (`tools/build.mjs`).
 *
 * - Default mode (`npm run build`):
 *   1. Bundles `src/web/main.jsx` -> `dist/web/app.js` + `dist/web/app.css` via esbuild
 *   2. Copies `index.html`, `manifest.webmanifest`, `sw.js`, `styles/theme.css` -> `dist/web/`
 *   3. Bundles `src/backend/worker.js` -> `dist/worker.js` (Cloudflare Workers ESM)
 * - Check mode (`npm run check` / `--check`):
 *   1. Runs dry-run esbuild validation of web + worker bundles
 *   2. Audits tracked source/config/doc files for accidental secrets or private keys
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const WEB_SRC = path.join(ROOT, 'src', 'web');
const WEB_DIST = path.join(DIST_DIR, 'web');

const SECRET_PATTERNS = [
  { name: 'OpenAI/Anthropic Live Key', re: /\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{24,}\b/ },
  { name: 'GitHub PAT', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/ },
  { name: 'Google API Key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Private Key PEM', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'AWS Secret Key', re: /\bAKIA[0-9A-Z]{16}\b/ },
];

const AUDIT_DIRS = ['src', 'tools', 'wrangler.toml', 'README.md', 'AI_SETUP.md', 'DEPLOY.md'];

function collectFiles(target) {
  const full = path.join(ROOT, target);
  if (!fs.existsSync(full)) return [];
  const stat = fs.statSync(full);
  if (stat.isFile()) return [full];
  const out = [];
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === '.data') {
      continue;
    }
    out.push(...collectFiles(path.join(target, entry.name)));
  }
  return out;
}

function runPrivacySecretAudit() {
  const findings = [];
  for (const target of AUDIT_DIRS) {
    for (const filePath of collectFiles(target)) {
      const content = fs.readFileSync(filePath, 'utf8');
      for (const pat of SECRET_PATTERNS) {
        if (pat.re.test(content)) {
          findings.push({ file: path.relative(ROOT, filePath), pattern: pat.name });
        }
      }
    }
  }
  if (findings.length > 0) {
    console.error('PRIVACY/SECRET AUDIT FAILED:');
    for (const f of findings) {
      console.error(`  - ${f.file}: matched ${f.pattern}`);
    }
    process.exit(1);
  }
  console.log('Privacy & secret hygiene audit: CLEAN');
}

async function buildBundles({ checkOnly = false } = {}) {
  const hasWebEntry = fs.existsSync(path.join(WEB_SRC, 'main.jsx'));
  const hasWorkerEntry = fs.existsSync(path.join(ROOT, 'src', 'backend', 'worker.js'));

  if (!checkOnly) {
    fs.mkdirSync(WEB_DIST, { recursive: true });
  }

  if (hasWebEntry) {
    await esbuild.build({
      entryPoints: [path.join(WEB_SRC, 'main.jsx')],
      bundle: true,
      format: 'esm',
      target: ['es2022'],
      jsx: 'automatic',
      minify: !checkOnly,
      sourcemap: !checkOnly,
      write: !checkOnly,
      outfile: path.join(WEB_DIST, 'app.js'),
      define: {
        'process.env.NODE_ENV': JSON.stringify('production'),
      },
    });

    if (!checkOnly) {
      // Copy static PWA files
      for (const staticFile of ['index.html', 'manifest.webmanifest', 'sw.js']) {
        const srcPath = path.join(WEB_SRC, staticFile);
        if (fs.existsSync(srcPath)) {
          fs.copyFileSync(srcPath, path.join(WEB_DIST, staticFile));
        }
      }
      const themeSrc = path.join(WEB_SRC, 'styles', 'theme.css');
      if (fs.existsSync(themeSrc)) {
        fs.copyFileSync(themeSrc, path.join(WEB_DIST, 'theme.css'));
      }
    }
    console.log(`Web PWA bundle (${checkOnly ? 'check' : 'dist/web/app.js'}): OK`);
  }

  if (hasWorkerEntry) {
    await esbuild.build({
      entryPoints: [path.join(ROOT, 'src', 'backend', 'worker.js')],
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: ['es2022'],
      mainFields: ['module', 'main'],
      conditions: ['worker', 'browser', 'import'],
      minify: false,
      write: !checkOnly,
      outfile: path.join(DIST_DIR, 'worker.js'),
    });
    console.log(`Cloudflare Worker bundle (${checkOnly ? 'check' : 'dist/worker.js'}): OK`);
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const checkOnly = args.has('--check');

  runPrivacySecretAudit();
  await buildBundles({ checkOnly });
  console.log(checkOnly ? 'Build check passed.' : 'Build complete.');
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
