import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { runSync, validateOrigin } from './worker.mjs';

const ORIGIN = 'https://preview.example.test';
const env = { SITE_ORIGIN: ORIGIN, SYNC_SECRET: 'test-app-token', SIWC_BYPASS_TOKEN: 'test-service-token' };
const media = queued => [{ status: 'ready', count: 3 }, { status: 'pending', count: queued }];
const sync = queued => ({ updated: 2, archived: 4, copied: 3, media: media(queued) });
const status = (queued = 0, error = null) => ({ posts: 10, media: media(queued), lastRun: { error } });
const json = body => Response.json(body);

function harness(replies, custom = {}) {
  const calls = [];
  const logs = [];
  const timeouts = [];
  let clock = 0;
  return {
    calls, logs, timeouts,
    advance: ms => { clock += ms; },
    dependencies: {
      now: () => clock,
      log: item => logs.push(item),
      signalFor: timeout => { timeouts.push(timeout); return new AbortController().signal; },
      fetchImpl: async (url, init) => {
        calls.push({ url, ...init });
        const reply = replies.shift();
        assert(reply, 'Unexpected outbound request');
        return typeof reply === 'function' ? reply(url, init) : reply;
      },
      ...custom,
    },
  };
}

test('validates exact HTTPS origin and rejects credentials, paths and queries before fetch', async () => {
  assert.equal(validateOrigin(ORIGIN), ORIGIN);
  for (const origin of [undefined, '', 'http://preview.example.test', `${ORIGIN}/`, `${ORIGIN}/path`,
    `${ORIGIN}?token=x`, `${ORIGIN}#x`, 'https://user:secret@preview.example.test', ` ${ORIGIN}`, 'https://PREVIEW.example.test']) {
    const h = harness([]);
    const result = await runSync({ ...env, SITE_ORIGIN: origin }, h.dependencies);
    assert.equal(result.reason, 'invalid_site_origin');
    assert.equal(h.calls.length, 0);
  }
});

test('uses fixed origin and private/application auth headers with manual redirects', async () => {
  const h = harness([json(sync(0)), json(status())]);
  const result = await runSync(env, h.dependencies);
  assert.equal(result.outcome, 'ok');
  assert.deepEqual(h.calls.map(call => [call.url, call.method]), [[`${ORIGIN}/api/sync`, 'POST'], [`${ORIGIN}/api/status`, 'GET']]);
  for (const call of h.calls) {
    assert.equal(call.redirect, 'manual');
    assert.equal(call.headers.get('Authorization'), 'Bearer test-app-token');
    assert.equal(call.headers.get('OAI-Sites-Authorization'), 'Bearer test-service-token');
    assert(call.signal instanceof AbortSignal);
  }
  assert.deepEqual(h.timeouts, [240_000, 240_000]);
  assert(!JSON.stringify(h.logs).includes('test-app-token'));
  assert(!JSON.stringify(h.logs).includes('test-service-token'));
});

test('requires application secret even for private Site and allows absent optional service secret', async () => {
  for (const secret of [undefined, '', ' token ', 'token\r\nInjected: value']) {
    const h = harness([]);
    const result = await runSync({ ...env, SYNC_SECRET: secret }, h.dependencies);
    assert.equal(result.reason, 'invalid_secret_configuration');
    assert.equal(h.calls.length, 0);
  }
  const h = harness([json(sync(0)), json(status())]);
  const result = await runSync({ ...env, SIWC_BYPASS_TOKEN: undefined }, h.dependencies);
  assert.equal(result.outcome, 'ok');
  assert.equal(h.calls[0].headers.get('OAI-Sites-Authorization'), null);
});

test('does not follow redirect or leak its target or body into logs', async () => {
  const h = harness([new Response('secret-bearing-body', { status: 302, headers: { Location: 'https://other.test/token' } })]);
  const result = await runSync(env, h.dependencies);
  assert.equal(result.reason, 'site_redirect');
  assert.equal(result.httpStatus, 302);
  assert.equal(h.calls.length, 1);
  assert(!JSON.stringify(h.logs).includes('other.test'));
  assert(!JSON.stringify(h.logs).includes('secret-bearing-body'));
});

test('409 busy and legacy busy response stop immediately without failure or extra requests', async () => {
  for (const reply of [new Response('IMPORT_BUSY', { status: 409 }), json({ busy: true })]) {
    const h = harness([reply]);
    const result = await runSync(env, h.dependencies);
    assert.equal(result.outcome, 'busy');
    assert.equal(h.calls.length, 1);
  }
  const h = harness([json(sync(5)), new Response('IMPORT_BUSY', { status: 409 })]);
  const result = await runSync(env, h.dependencies);
  assert.equal(result.outcome, 'busy');
  assert.equal(h.calls.length, 2);
});

test('media stops on empty queue and checks final status', async () => {
  const h = harness([json(sync(6)), json({ copied: 6, media: media(0) }), json(status())]);
  const result = await runSync(env, h.dependencies);
  assert.equal(result.outcome, 'ok');
  assert.equal(result.mediaPasses, 1);
  assert.equal(result.copied, 9);
  assert.deepEqual(h.calls.map(call => call.method), ['POST', 'POST', 'GET']);
});

test('media stops after no copies even with retry-dated queue remaining', async () => {
  const h = harness([json(sync(6)), json({ copied: 0, media: [{ status: 'error', count: 6 }] }), json(status(6))]);
  const result = await runSync(env, h.dependencies);
  assert.equal(result.outcome, 'ok');
  assert.equal(result.mediaPasses, 1);
  assert.equal(result.mediaQueued, 6);
  assert.equal(h.calls.length, 3);
});

test('media work is capped at five passes and seven total requests', async () => {
  const replies = [json(sync(99)), ...Array.from({ length: 5 }, () => json({ copied: 1, media: media(99) })), json(status(99))];
  const h = harness(replies);
  const result = await runSync(env, h.dependencies);
  assert.equal(result.outcome, 'ok');
  assert.equal(result.mediaPasses, 5);
  assert.equal(h.calls.length, 7);
});

test('rejects invalid MEDIA_PASSES including 41 before any request', async () => {
  for (const passes of ['41', 41, '-1', -1, '1.5', 1.5, '', ' 5 ', '05', 'banana', true, null]) {
    const h = harness([]);
    const result = await runSync({ ...env, MEDIA_PASSES: passes }, h.dependencies);
    assert.equal(result.outcome, 'error');
    assert.equal(result.reason, 'invalid_media_passes');
    assert.equal(h.calls.length, 0);
  }
});

test('40-pass archive drain still syncs news first and caps total requests at 42', async () => {
  const h = harness([json(sync(999)), ...Array.from({ length: 40 }, () => json({ copied: 20, media: media(999) })), json(status(999))]);
  const result = await runSync({ ...env, MEDIA_PASSES: '40' }, h.dependencies);
  assert.equal(result.outcome, 'ok');
  assert.equal(result.mediaPasses, 40);
  assert.equal(result.copied, 803);
  assert.equal(h.calls.length, 42);
  assert.equal(h.calls[0].url, `${ORIGIN}/api/sync`);
  assert.equal(h.calls[41].url, `${ORIGIN}/api/status`);
  assert(h.calls.slice(1, 41).every(call => call.url === `${ORIGIN}/api/media` && call.method === 'POST'));
});

test('zero media passes performs news sync and status without an archive drain', async () => {
  const h = harness([json(sync(999)), json(status(999))]);
  const result = await runSync({ ...env, MEDIA_PASSES: '0' }, h.dependencies);
  assert.equal(result.outcome, 'ok');
  assert.equal(result.mediaPasses, 0);
  assert.equal(h.calls.length, 2);
});

test('lastRun.error prevents success and response error text stays out of logs', async () => {
  const h = harness([json(sync(0)), json(status(0, 'test-app-token private detail'))]);
  const result = await runSync({ ...env, MEDIA_PASSES: '40' }, h.dependencies);
  assert.equal(result.outcome, 'error');
  assert.equal(result.reason, 'site_last_run_error');
  assert(!JSON.stringify(h.logs).includes('private detail'));
  assert(!JSON.stringify(h.logs).includes('test-app-token'));
});

test('HTTP errors, network exception text and oversized bodies are never logged', async () => {
  const h = harness([new Response('test-app-token secret', { status: 401 })]);
  const result = await runSync(env, h.dependencies);
  assert.equal(result.httpStatus, 401);
  assert.equal(result.reason, 'site_http_error');
  const network = harness([() => { throw new Error('test-app-token fetch debug'); }]);
  assert.equal((await runSync(env, network.dependencies)).reason, 'network_or_timeout');
  assert(!JSON.stringify(network.logs).includes('test-app-token'));
  const oversized = harness([new Response('a'.repeat(65_537))]);
  assert.equal((await runSync(env, oversized.dependencies)).reason, 'site_response_too_large');
});

test('reserves final readback time and reduces each timeout to remaining budget', async () => {
  const h = harness([
    () => { h.advance(240_000); return json(sync(10)); },
    () => { h.advance(240_000); return json({ copied: 1, media: media(9) }); },
    json(status(9)),
  ]);
  const result = await runSync({ ...env, MEDIA_PASSES: '40' }, h.dependencies);
  assert.equal(result.outcome, 'partial');
  assert.equal(result.reason, 'media_deadline');
  assert.deepEqual(h.timeouts, [240_000, 240_000, 30_000]);
  assert.equal(h.calls.length, 3);
});

const forbidden = () => Response.json({ error: 'Error: Source HTTP 403; retry later; details={"htmlTitle":"Just a moment..."}' }, { status: 502 });

test('recognized source 403 preserves news failure while copying queued media and reading status', async () => {
  const h = harness([forbidden(), json({ copied: 20, media: media(3) }), json({ copied: 3, media: media(0) }), json(status(0, 'Error: Source HTTP 403; retry later'))]);
  const result = await runSync({ ...env, SIWC_BYPASS_TOKEN: undefined }, h.dependencies);
  assert.equal(result.outcome, 'error');
  assert.equal(result.reason, 'source_http_403');
  assert.equal(result.httpStatus, 502);
  assert.equal(result.sourceStatus, 403);
  assert.equal(result.updated, 0);
  assert.equal(result.archived, 0);
  assert.equal(result.copied, 23);
  assert.equal(result.mediaPasses, 2);
  assert.equal(result.archiveOutcome, 'ok');
  assert.equal(result.posts, 10);
  assert.equal(result.mediaQueued, 0);
  assert.deepEqual(h.calls.map(call => call.url), ['/api/sync', '/api/media', '/api/media', '/api/status'].map(path => ORIGIN + path));
  for (const call of h.calls) {
    assert.equal(call.headers.get('Authorization'), 'Bearer test-app-token');
    assert.equal(call.headers.get('OAI-Sites-Authorization'), null);
    assert.equal(call.redirect, 'manual');
  }
  assert.doesNotMatch(JSON.stringify(h.logs), /test-app-token|Just a moment|details/);
});

test('source 403 fallback caps default and drain calls at seven and 42', async () => {
  for (const passes of [undefined, '40']) {
    const limit = passes === undefined ? 5 : 40;
    const h = harness([forbidden(), ...Array.from({ length: limit }, () => json({ copied: 20, media: media(999) })), json(status(999))]);
    const result = await runSync({ ...env, MEDIA_PASSES: passes }, h.dependencies);
    assert.equal(result.outcome, 'error');
    assert.equal(result.reason, 'source_http_403');
    assert.equal(result.copied, limit * 20);
    assert.equal(result.mediaPasses, limit);
    assert.equal(h.calls.length, limit + 2);
  }
});

test('fallback never starts for authentication errors, unrelated 502, malformed or oversized responses', async () => {
  const replies = [
    Response.json({ error: 'Source HTTP 403' }, { status: 401 }),
    Response.json({ error: 'Source HTTP 403' }, { status: 429 }),
    Response.json({ error: 'Source HTTP 403' }, { status: 403 }),
    Response.json({ error: 'Error: Source HTTP 404; retry later' }, { status: 502 }),
    Response.json({ error: 'Storage unavailable; Source HTTP 403' }, { status: 502 }),
    Response.json({ error: 'Source HTTP 4030' }, { status: 502 }),
    new Response('Source HTTP 403', { status: 502 }),
    new Response('a'.repeat(65_537), { status: 502 }),
  ];
  for (const reply of replies) {
    const h = harness([reply]);
    const result = await runSync(env, h.dependencies);
    assert.equal(result.outcome, 'error');
    assert.equal(result.mediaPasses, 0);
    assert.equal(h.calls.length, 1);
    assert.notEqual(result.reason, 'source_http_403');
  }
});

test('fallback stops on zero copies and retains source failure through an archive busy response', async () => {
  const zero = harness([forbidden(), json({ copied: 0, media: media(9) }), json(status(9, 'Source HTTP 403; retry later'))]);
  const noCopies = await runSync(env, zero.dependencies);
  assert.equal(noCopies.reason, 'source_http_403');
  assert.equal(noCopies.copied, 0);
  assert.equal(noCopies.mediaPasses, 1);
  assert.equal(noCopies.mediaQueued, 9);
  assert.equal(zero.calls.length, 3);
  const busy = harness([forbidden(), new Response('', { status: 409 })]);
  const unavailable = await runSync(env, busy.dependencies);
  assert.equal(unavailable.outcome, 'error');
  assert.equal(unavailable.reason, 'source_http_403');
  assert.equal(unavailable.archiveOutcome, 'busy');
  assert.equal(unavailable.archiveReason, 'site_writer_busy');
  assert.equal(unavailable.httpStatus, 502);
  assert.equal(busy.calls.length, 2);
});

test('fallback preserves news failure and reserves readback time at partial media budget', async () => {
  const h = harness([
    () => { h.advance(240_000); return forbidden(); },
    () => { h.advance(240_000); return json({ copied: 20, media: media(9) }); },
    json(status(9, 'Error: Source HTTP 403; retry later')),
  ]);
  const result = await runSync({ ...env, MEDIA_PASSES: '40' }, h.dependencies);
  assert.equal(result.outcome, 'error');
  assert.equal(result.reason, 'source_http_403');
  assert.equal(result.archiveOutcome, 'partial');
  assert.equal(result.archiveReason, 'media_deadline');
  assert.equal(result.copied, 20);
  assert.equal(result.httpStatus, 502);
  assert.deepEqual(h.timeouts, [240_000, 240_000, 30_000]);
});

test('fallback readback permits only null or recognized source403 and logs no errors or secrets', async () => {
  for (const error of ['Error: Source HTTP 404; test-app-token private', undefined, 'Private storage failure']) {
    const readback = error === undefined ? { posts: 10, media: media(0), lastRun: {} } : status(0, error);
    const h = harness([forbidden(), json({ copied: 20, media: media(0) }), json(readback)]);
    const result = await runSync(env, h.dependencies);
    assert.equal(result.outcome, 'error');
    assert.equal(result.reason, 'source_http_403');
    assert.equal(result.archiveOutcome, 'error');
    assert.equal(result.archiveReason, 'site_last_run_error');
    assert.equal(result.copied, 20);
    assert.doesNotMatch(JSON.stringify(h.logs), /test-app-token|Private|private|404/);
  }
  const h = harness([forbidden(), new Response('test-app-token private', { status: 401 })]);
  const result = await runSync(env, h.dependencies);
  assert.equal(result.reason, 'source_http_403');
  assert.equal(result.httpStatus, 502);
  assert.equal(result.archiveHttpStatus, 401);
  assert.equal(result.archiveReason, 'site_http_error');
  assert.doesNotMatch(JSON.stringify(h.logs), /test-app-token|private/);
});

test('fallback preserves explicitly configured private-Site credential and sync network failure never falls back', async () => {
  const h = harness([forbidden(), json({ copied: 1, media: media(0) }), json(status())]);
  await runSync(env, h.dependencies);
  assert(h.calls.every(call => call.headers.get('OAI-Sites-Authorization') === 'Bearer test-service-token'));
  const network = harness([() => { throw new Error('Source HTTP 403 test-app-token private timeout'); }]);
  const result = await runSync(env, network.dependencies);
  assert.equal(result.reason, 'network_or_timeout');
  assert.equal(result.mediaPasses, 0);
  assert.equal(network.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(network.logs), /test-app-token|private|403/);
});

test('RSS import remains partial with actual new or zero counts and successful archive/readback', async () => {
  for (const updated of [0, 3]) {
    const h = harness([json({ ...sync(2), mode: 'rss', updated }), json({ copied: 2, media: media(0) }), json(status())]);
    const result = await runSync(env, h.dependencies);
    assert.equal(result.sourceMode, 'rss');
    assert.equal(result.sourceStatus, 403);
    assert.equal(result.outcome, 'partial');
    assert.equal(result.reason, 'rss_metadata_incomplete');
    assert.equal(result.updated, updated);
    assert.equal(result.archived, 4);
    assert.equal(result.copied, 5);
    assert.equal(result.archiveOutcome, 'ok');
    assert.equal(result.posts, 10);
    assert.equal(h.calls.length, 3);
  }
});

test('RSS uses the same seven-request default cap and preserves readback budget', async () => {
  const full = harness([json({ ...sync(99), mode: 'rss' }), ...Array.from({ length: 5 }, () => json({ copied: 1, media: media(99) })), json(status(99))]);
  const result = await runSync(env, full.dependencies);
  assert.equal(result.outcome, 'partial');
  assert.equal(result.reason, 'rss_metadata_incomplete');
  assert.equal(result.mediaPasses, 5);
  assert.equal(full.calls.length, 7);
  const budget = harness([
    () => { budget.advance(240_000); return json({ ...sync(9), mode: 'rss' }); },
    () => { budget.advance(240_000); return json({ copied: 1, media: media(8) }); },
    json(status(8)),
  ]);
  const partial = await runSync(env, budget.dependencies);
  assert.equal(partial.outcome, 'partial');
  assert.equal(partial.reason, 'rss_metadata_incomplete');
  assert.equal(partial.archiveOutcome, 'partial');
  assert.equal(partial.archiveReason, 'media_deadline');
  assert.deepEqual(budget.timeouts, [240_000, 240_000, 30_000]);
});

test('RSS still requires a null final lastRun.error and does not allow source403 there', async () => {
  const h = harness([json({ ...sync(0), mode: 'rss' }), json(status(0, 'Error: Source HTTP 403; private test-app-token'))]);
  const result = await runSync(env, h.dependencies);
  assert.equal(result.outcome, 'error');
  assert.equal(result.reason, 'site_last_run_error');
  assert.equal(result.sourceMode, 'rss');
  assert.doesNotMatch(JSON.stringify(h.logs), /private|test-app-token/);
});

test('missing or explicit REST mode remains compatible; unknown modes stop before media requests', async () => {
  for (const mode of [undefined, 'rest']) {
    const h = harness([json({ ...sync(0), ...(mode ? { mode } : {}) }), json(status())]);
    assert.equal((await runSync(env, h.dependencies)).outcome, 'ok');
  }
  for (const mode of ['xml', 'RSS', '', null, true, { mode: 'rss' }]) {
    const h = harness([json({ ...sync(9), mode })]);
    const result = await runSync(env, h.dependencies);
    assert.equal(result.outcome, 'error');
    assert.equal(result.reason, 'invalid_site_response');
    assert.equal(result.updated, 0);
    assert.equal(h.calls.length, 1);
  }
});

test('shared scheduler has no HTTP handler and exposes its run function', () => {
  assert.equal(typeof worker.scheduled, 'function');
  assert.equal(Object.hasOwn(worker, 'fetch'), false);
  assert.equal(typeof runSync, 'function');
});
