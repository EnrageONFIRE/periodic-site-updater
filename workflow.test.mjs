import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const workflow = (await readFile(new URL('./.github/workflows/sync.yml', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const runner = await readFile(new URL('./run-once.mjs', import.meta.url), 'utf8');
const CHECKOUT = 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683';

function block(text, key) {
  const match = text.match(new RegExp(`^${key}:\\n([\\s\\S]*?)(?=^[a-zA-Z][a-zA-Z-]*:|$(?![\\s\\S]))`, 'm'));
  assert(match, `Missing ${key} block`);
  return match[1];
}

// Validate this deliberately small workflow's security boundaries, not general YAML.
function validateWorkflow(text) {
  assert.doesNotMatch(text, /\t|^\s*permissions:\s*(?:write-all|read-all)|^\s*secrets:\s*inherit/m);
  const triggers = block(text, 'on');
  assert.deepEqual([...triggers.matchAll(/^  ([a-z_]+):/gm)].map(match => match[1]), ['schedule', 'workflow_dispatch']);
  assert.deepEqual([...triggers.matchAll(/cron:\s*'([^']+)'/g)].map(match => match[1]), ['3-59/10 * * * *']);
  assert.equal(block(text, 'permissions').trim(), 'contents: read');
  assert.match(block(text, 'concurrency'), /^  group: site-news-sync\n  cancel-in-progress: false\s*$/);
  assert.match(text, /^    runs-on: ubuntu-latest$/m);
  assert.match(text, /^    timeout-minutes: 10$/m);
  assert.deepEqual([...text.matchAll(/\buses:\s*(\S+)/g)].map(match => match[1]), [CHECKOUT]);
  assert.match(text, /^          persist-credentials: false$/m);
  const runSteps = [...text.matchAll(/^        run: (.+)$/gm)].map(match => match[1]);
  assert.equal(runSteps.length, 3);
  assert.match(runSteps[0], /process\.versions\.node\.split\('\.'\)\[0\]\) < 22/);
  assert.equal(runSteps[1], 'node --test worker.test.mjs workflow.test.mjs');
  assert.equal(runSteps[2], 'node run-once.mjs');
  assert.deepEqual([...text.matchAll(/secrets\.([A-Z_]+)/g)].map(match => match[1]), ['SITE_ORIGIN', 'SYNC_SECRET']);
  assert.match(text, /^          SYNC_SECRET: \$\{\{ secrets\.SYNC_SECRET \}\}$/m);
  assert.match(text, /^          SITE_ORIGIN: \$\{\{ secrets\.SITE_ORIGIN \}\}$/m);
  assert.match(text, /^          MEDIA_PASSES: '5'$/m);
  assert.doesNotMatch(text, /SIWC|OAI-Sites|pull_request|push:|npm |npx |curl |upload-artifact|write-all|contents: write/);
}

test('workflow restricts events, permissions, runtime, origin, secrets and action pin', () => {
  validateWorkflow(workflow);
  const minutes = Array.from({ length: 6 }, (_, index) => 3 + 10 * index);
  assert.deepEqual(minutes, [3, 13, 23, 33, 43, 53]);
});

test('structural guard rejects dangerous edits and accidental alternate schedules', () => {
  for (const changed of [
    workflow.replace('  workflow_dispatch:', '  pull_request:'),
    workflow.replace('contents: read', 'contents: write'),
    workflow.replace('cancel-in-progress: false', 'cancel-in-progress: true'),
    workflow.replace(CHECKOUT, 'actions/checkout@v4'),
    workflow.replace('secrets.SYNC_SECRET', 'secrets.SIWC_BYPASS_TOKEN'),
    workflow.replace('${{ secrets.SITE_ORIGIN }}', 'https://other.test'),
    workflow.replace('3-59/10 * * * *', '*/5 * * * *'),
    workflow.replace('node run-once.mjs', 'curl https://other.test'),
  ]) assert.throws(() => validateWorkflow(changed));
});

test('GitHub runner accepts app secret via environment only and no platform credential', () => {
  assert.match(runner, /SYNC_SECRET: process\.env\.SYNC_SECRET/);
  assert.doesNotMatch(runner, /SIWC|OAI-Sites|process\.argv|\.env['"]|readFile|writeFile/);
});

test('missing Actions secret fails closed before any remote request, without logging env secrets', () => {
  const result = spawnSync(process.execPath, ['run-once.mjs'], {
    cwd: new URL('.', import.meta.url), encoding: 'utf8',
    env: { ...process.env, SITE_ORIGIN: 'https://preview.example.test', SYNC_SECRET: '', SIWC_BYPASS_TOKEN: 'must-not-be-used-or-printed', MEDIA_PASSES: '5' },
  });
  assert.equal(result.status, 1);
  const summary = JSON.parse(result.stdout.trim());
  assert.equal(summary.reason, 'invalid_secret_configuration');
  assert.equal(summary.copied, 0);
  assert.doesNotMatch(result.stdout + result.stderr, /must-not-be-used-or-printed|preview\.example/);
});
