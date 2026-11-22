import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');

describe('Web PWA & Cloudflare Worker Build Smoke', () => {
  it('passes privacy/secret hygiene check and produces dist/web/* + dist/worker.js', () => {
    const checkOut = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build.mjs'), '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.match(checkOut, /Privacy & secret hygiene audit: CLEAN/);
    assert.match(checkOut, /Build check passed/);

    const buildOut = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.match(buildOut, /Build complete/);

    const expectedFiles = [
      path.join(ROOT, 'dist', 'web', 'index.html'),
      path.join(ROOT, 'dist', 'web', 'app.js'),
      path.join(ROOT, 'dist', 'web', 'theme.css'),
      path.join(ROOT, 'dist', 'web', 'manifest.webmanifest'),
      path.join(ROOT, 'dist', 'web', 'sw.js'),
      path.join(ROOT, 'dist', 'worker.js'),
    ];
    for (const file of expectedFiles) {
      assert.ok(fs.existsSync(file), `Expected built file to exist: ${file}`);
      assert.ok(fs.statSync(file).size > 0, `Expected non-empty built file: ${file}`);
    }

    const html = fs.readFileSync(path.join(ROOT, 'dist', 'web', 'index.html'), 'utf8');
    assert.match(html, /name="robots"\s+content="noindex,\s*nofollow"/i);
  });
});
