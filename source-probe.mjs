// One bounded, ordinary public-source diagnostic. No retries or alternate routes.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 128 * 1024;
const TIMEOUT_MS = 15_000;
const USER_AGENT = 'DailyMirror/1.0 (authorized source availability diagnostic)';

function origin(value) {
  try {
    const url = new URL(value);
    if (typeof value !== 'string' || value !== url.origin || url.protocol !== 'https:' ||
        url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    return url.origin;
  } catch { return null; }
}

function empty() {
  return { status: 0, contentKind: 'not_requested', cfChallenge: false };
}

function isChallenge(body) {
  return /^\s*(?:<!doctype html[^>]*>\s*)?<html(?:\s|>)/i.test(body) &&
    /<title[^>]*>\s*Just a moment(?:\.\.\.)?\s*<\/title>/i.test(body) &&
    /(?:\/cdn-cgi\/challenge-platform\/|\bcf-chl-|\b_cf_chl_opt\b)/i.test(body);
}

async function textWithinLimit(response) {
  if (!response.body) return { body: '', challenge: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let body = '';
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) return { body: null, challenge: false };
      body += decoder.decode(value, { stream: true });
      if (isChallenge(body)) return { body: null, challenge: true };
    }
    body += decoder.decode();
    return { body, challenge: isChallenge(body) };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function feedCount(body) {
  // Ignore article CDATA and comments so article markup cannot become feed items.
  const xml = body.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const start = xml.replace(/^\uFEFF/, '').trimStart().replace(/^<\?xml[\s\S]*?\?>\s*/, '');
  if (/^<rss(?:\s|>)/i.test(start) && /<\/rss>\s*$/i.test(xml)) {
    const opens = (xml.match(/<item(?:\s[^>]*|)>/gi) || []).length;
    const closes = (xml.match(/<\/item\s*>/gi) || []).length;
    if (opens === closes && /<channel(?:\s|>)/i.test(xml) && /<\/channel>/i.test(xml)) {
      return { contentKind: 'rss', feedItemCount: opens };
    }
  }
  if (/^<feed(?:\s|>)/i.test(start) && /<\/feed>\s*$/i.test(xml)) {
    const opens = (xml.match(/<entry(?:\s[^>]*|)>/gi) || []).length;
    const closes = (xml.match(/<\/entry\s*>/gi) || []).length;
    if (opens === closes) return { contentKind: 'atom', feedItemCount: opens };
  }
  return null;
}

async function probe(source, kind, dependencies) {
  const result = { status: 0, contentKind: 'unavailable', cfChallenge: false };
  let response;
  try {
    response = await dependencies.fetchImpl(source + (kind === 'feed'
      ? '/feed/' : '/wp-json/wp/v2/posts?per_page=1&_fields=id,date_gmt,link'), {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: kind === 'feed' ? 'application/rss+xml, application/xml, text/xml;q=0.9' : 'application/json',
      },
      redirect: 'manual',
      signal: dependencies.signalFor(TIMEOUT_MS),
    });
    result.status = response.status;
    result.cfChallenge = response.headers.get('cf-mitigated')?.trim().toLowerCase() === 'challenge';
    if (result.cfChallenge || (response.status >= 300 && response.status < 400)) {
      result.contentKind = result.cfChallenge ? 'challenge' : 'redirect';
      await response.body?.cancel().catch(() => {});
      return { result, readable: false };
    }
    const text = await textWithinLimit(response);
    // The standard challenge is identified only; nothing from its page is returned.
    result.cfChallenge = text.challenge;
    if (result.cfChallenge) { result.contentKind = 'challenge'; return { result, readable: false }; }
    const body = text.body;
    if (body === null) { result.contentKind = 'over_limit'; return { result, readable: false }; }
    if (kind === 'feed') {
      const parsed = feedCount(body);
      if (parsed) { Object.assign(result, parsed); return { result, readable: response.status === 200 }; }
    } else {
      try {
        const records = JSON.parse(body);
        if (Array.isArray(records) && records.every(record => record && typeof record === 'object' &&
            Number.isSafeInteger(record.id) && record.id > 0 && typeof record.date_gmt === 'string' &&
            typeof record.link === 'string')) {
          result.contentKind = 'json';
          result.restRecordCount = records.length;
          return { result, readable: response.status === 200 };
        }
      } catch { /* Keep source parser errors out of logs. */ }
    }
    const type = response.headers.get('content-type') || '';
    result.contentKind = /text\/html/i.test(type) || /<html(?:\s|>)/i.test(body) ? 'html' :
      /json/i.test(type) ? 'json_other' : /xml/i.test(type) ? 'xml_other' : 'other';
  } catch {
    // Network/decoder errors may include addresses; report only the fixed kind.
    result.contentKind = 'unavailable';
    await response?.body?.cancel().catch(() => {});
  }
  return { result, readable: false };
}

export async function runProbe(env, dependencies = {}) {
  const source = origin(env.SOURCE_ORIGIN);
  const summary = { feed: empty(), rest: empty() };
  if (!source) return { summary, exitCode: 1 };
  const deps = {
    fetchImpl: dependencies.fetchImpl || globalThis.fetch,
    signalFor: dependencies.signalFor || (ms => AbortSignal.timeout(ms)),
  };
  const feed = await probe(source, 'feed', deps);
  summary.feed = feed.result;
  // These two known routes are independent. A challenge is never executed or retried.
  const rest = await probe(source, 'rest', deps);
  summary.rest = rest.result;
  return { summary, exitCode: feed.readable || rest.readable ? 0 : 1 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { summary, exitCode } = await runProbe({ SOURCE_ORIGIN: process.env.SOURCE_ORIGIN });
    console.log(JSON.stringify(summary));
    process.exitCode = exitCode;
  } catch {
    console.log(JSON.stringify({ feed: empty(), rest: empty() }));
    process.exitCode = 1;
  }
}
