// Independent scheduler. The Site owns all import, locking, and archive state.
const RUN_BUDGET_MS = 510_000; // 8.5 minutes; leave room before the next trigger.
const REQUEST_BUDGET_MS = 240_000;
const STATUS_RESERVE_MS = 30_000;
const DEFAULT_MEDIA_PASSES = 5;
const MAX_MEDIA_PASSES = 40;
const MAX_RESPONSE_BYTES = 65_536;
const SOURCE_FORBIDDEN = Symbol('source_forbidden');

class SafeFailure extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function validateOrigin(value) {
  try {
    const url = new URL(value);
    if (typeof value !== 'string' || value !== url.origin || url.protocol !== 'https:' ||
        url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new SafeFailure('invalid_site_origin');
  }
}

function token(value, required) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\r\n]/.test(value)) {
    throw new SafeFailure('invalid_secret_configuration');
  }
  return value;
}

function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new SafeFailure('invalid_site_response');
  return value;
}

function mediaPassLimit(value) {
  if (value === undefined) return DEFAULT_MEDIA_PASSES;
  const number = typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(number) || number < 0 || number > MAX_MEDIA_PASSES) {
    throw new SafeFailure('invalid_media_passes');
  }
  return number;
}

function queuedMedia(body) {
  if (!Array.isArray(body.media)) throw new SafeFailure('invalid_site_response');
  return body.media.reduce((total, row) => {
    if (!row || !['ready', 'pending', 'error'].includes(row.status)) {
      throw new SafeFailure('invalid_site_response');
    }
    return total + (row.status === 'ready' ? 0 : count(row.count));
  }, 0);
}

function isSourceForbidden(error) {
  // Match only the Site's fixed source-fetch error prefix, never arbitrary 502 text.
  return typeof error === 'string' && error.length <= 4096 &&
    /^(?:Error: )?Source HTTP 403(?:;|$)/.test(error);
}

async function readJson(response) {
  if (!response.body) throw new SafeFailure('invalid_site_response');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new SafeFailure('site_response_too_large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new SafeFailure('invalid_site_response'); }
}

export async function runSync(env, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const now = dependencies.now || Date.now;
  const signalFor = dependencies.signalFor || (ms => AbortSignal.timeout(ms));
  const log = dependencies.log || (summary => console.log(JSON.stringify(summary)));
  const deadline = now() + RUN_BUDGET_MS;
  const summary = { outcome: 'error', updated: 0, archived: 0, copied: 0, mediaPasses: 0 };
  let origin;
  let headers;
  let sourceForbidden = false;
  let rss = false;

  async function call(path, method, reserve = STATUS_RESERVE_MS) {
    const timeout = Math.min(REQUEST_BUDGET_MS, deadline - now() - reserve);
    if (timeout <= 0) throw new SafeFailure('deadline');
    const response = await fetchImpl(`${origin}${path}`, {
      method, headers, redirect: 'manual', signal: signalFor(timeout),
    });
    // Never follow any redirect: authentication must only reach the configured origin.
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new SafeFailure('site_redirect', response.status);
    }
    if (response.status === 409) {
      await response.body?.cancel().catch(() => {});
      return { busy: true };
    }
    if (!response.ok) {
      if (path === '/api/sync' && response.status === 502) {
        const body = await readJson(response);
        if (isSourceForbidden(body.error)) return SOURCE_FORBIDDEN;
      } else {
        await response.body?.cancel().catch(() => {});
      }
      throw new SafeFailure('site_http_error', response.status);
    }
    return readJson(response);
  }

  try {
    origin = validateOrigin(env.SITE_ORIGIN);
    const mediaPasses = mediaPassLimit(env.MEDIA_PASSES);
    headers = new Headers({ Accept: 'application/json' });
    headers.set('Authorization', `Bearer ${token(env.SYNC_SECRET, true)}`);
    const bypass = token(env.SIWC_BYPASS_TOKEN, false);
    if (bypass) headers.set('OAI-Sites-Authorization', `Bearer ${bypass}`);

    const sync = await call('/api/sync', 'POST');
    if (sync.busy) {
      summary.outcome = 'busy';
      summary.reason = 'site_writer_busy';
    } else {
      let queue;
      if (sync === SOURCE_FORBIDDEN) {
        sourceForbidden = true;
        summary.reason = 'source_http_403';
        summary.httpStatus = 502;
        summary.sourceStatus = 403;
        queue = 1; // Unknown queue: the first media response provides its actual count.
      } else {
        if (sync.mode !== undefined && sync.mode !== 'rest' && sync.mode !== 'rss') {
          throw new SafeFailure('invalid_site_response');
        }
        rss = sync.mode === 'rss';
        if (rss) {
          summary.sourceMode = 'rss';
          summary.sourceStatus = 403;
          summary.outcome = 'partial';
          summary.reason = 'rss_metadata_incomplete';
        }
        summary.updated = count(sync.updated);
        summary.archived = count(sync.archived);
        summary.copied = count(sync.copied);
        queue = queuedMedia(sync);
      }
      for (let pass = 0; pass < mediaPasses && queue > 0; pass++) {
        if (now() >= deadline - STATUS_RESERVE_MS) {
          if (sourceForbidden || rss) {
            summary.archiveOutcome = 'partial';
            summary.archiveReason = 'media_deadline';
          } else summary.reason = 'media_deadline';
          break;
        }
        const media = await call('/api/media', 'POST');
        if (media.busy) {
          if (sourceForbidden || rss) {
            summary.archiveOutcome = 'busy';
            summary.archiveReason = 'site_writer_busy';
          } else {
            summary.outcome = 'busy';
            summary.reason = 'site_writer_busy';
          }
          break;
        }
        const copied = count(media.copied);
        summary.mediaPasses++;
        summary.copied += copied;
        queue = queuedMedia(media);
        if (copied === 0) break; // Retry-dated errors may remain queued.
      }
      if (summary.outcome !== 'busy' && summary.archiveOutcome !== 'busy') {
        const status = await call('/api/status', 'GET', 0);
        if (status.busy) throw new SafeFailure('status_unavailable');
        if (!status.lastRun || (status.lastRun.error !== null && !(sourceForbidden && isSourceForbidden(status.lastRun.error)))) {
          throw new SafeFailure('site_last_run_error');
        }
        summary.posts = count(status.posts);
        summary.mediaQueued = queuedMedia(status);
        if (sourceForbidden) summary.archiveOutcome = summary.archiveReason === 'media_deadline' ? 'partial' : 'ok';
        else if (rss) {
          summary.archiveOutcome = summary.archiveReason === 'media_deadline' ? 'partial' : 'ok';
          summary.outcome = 'partial';
          summary.reason = 'rss_metadata_incomplete';
        }
        else summary.outcome = summary.reason === 'media_deadline' ? 'partial' : 'ok';
      }
    }
  } catch (error) {
    const outcome = error instanceof SafeFailure && error.code === 'deadline' ? 'partial' : 'error';
    const reason = error instanceof SafeFailure ? error.code : 'network_or_timeout';
    if (sourceForbidden) {
      summary.archiveOutcome = outcome;
      summary.archiveReason = reason;
      if (error instanceof SafeFailure && Number.isInteger(error.status)) summary.archiveHttpStatus = error.status;
    } else {
      summary.outcome = outcome;
      summary.reason = reason;
      if (error instanceof SafeFailure && Number.isInteger(error.status)) summary.httpStatus = error.status;
    }
  }
  log(summary); // Counts and fixed error codes only; never secrets or response bodies.
  return summary;
}

export default {
  async scheduled(_controller, env) {
    const summary = await runSync(env);
    // Mark failures as failures in Cloudflare metrics; the thrown message is fixed.
    if (summary.outcome === 'error') throw new Error('Site synchronization failed; see safe summary.');
  },
};
