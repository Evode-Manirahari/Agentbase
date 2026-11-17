import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// This client only ever READS. That is the reason it is allowed to retry a
// timeout or a 5xx without asking anyone: a repeated read creates nothing.
// The same reflex applied to a write is how one booking becomes two, which is
// the failure this tool exists to find.
//
// Endpoints follow the Retell API reference (spec revision 2026-11-15):
//   POST /v3/list-calls           list, without transcripts
//   GET  /v2/get-call/{call_id}   one call, with transcript_with_tool_calls
// The list page's own note points at /v1/get-call while the get-call page
// documents /v2, so a 404 on v2 falls back to v1 once and the answer is kept.

export const DEFAULT_BASE_URL = 'https://api.retellai.com';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PAGES = 200;
const SAFE_CALL_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class RetellError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'RetellError';
    this.status = status;
  }
}

export interface RetellClientOptions {
  apiKey: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
  concurrency: number;
  maxRetries: number;
  sleep: (ms: number) => Promise<void>;
  /** Raw call objects are cached here so a rerun does not refetch. Null disables it. */
  cacheDir: string | null;
  onProgress: ((done: number, total: number) => void) | null;
}

export function retellClientOptions(apiKey: string, overrides: Partial<RetellClientOptions> = {}): RetellClientOptions {
  return {
    apiKey,
    baseUrl: DEFAULT_BASE_URL,
    fetchImpl: fetch,
    concurrency: 4,
    maxRetries: 5,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    cacheDir: null,
    onProgress: null,
    ...overrides,
  };
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

function backoffMs(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

async function requestJson(
  opts: RetellClientOptions,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown; text: string }> {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}${path}`;
  const headers: Record<string, string> = { authorization: `Bearer ${opts.apiKey}`, accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';

  for (let attempt = 0; ; attempt += 1) {
    const last = attempt >= opts.maxRetries;
    let res: Response;
    try {
      res = await opts.fetchImpl(url, {
        method,
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      if (last) {
        throw new RetellError(`Could not reach Retell (${err instanceof Error ? err.message : String(err)}).`);
      }
      await opts.sleep(backoffMs(attempt));
      continue;
    }

    if (res.status === 401 || res.status === 403) {
      throw new RetellError(`Retell rejected the API key (HTTP ${res.status}). Check RETELL_API_KEY.`, res.status);
    }
    if (res.status === 429 || res.status >= 500) {
      if (last) {
        throw new RetellError(`Retell kept answering HTTP ${res.status} after ${attempt + 1} tries.`, res.status);
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      await opts.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt));
      continue;
    }

    const text = await res.text();
    let json: unknown = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      // A non-JSON body. The caller decides what that means for its status code.
    }
    return { status: res.status, json, text };
  }
}

export interface ListParams {
  fromMs: number;
  toMs: number;
  agentIds: string[];
  maxCalls: number;
}

export interface ListResult {
  ids: string[];
  /** True when --max-calls stopped the listing before the window was exhausted. */
  truncated: boolean;
}

export async function listEndedCallIds(opts: RetellClientOptions, params: ListParams): Promise<ListResult> {
  const ids: string[] = [];
  const seenKeys = new Set<string>();
  let paginationKey: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const filter: Rec = { start_timestamp: { op: 'bt', value: [params.fromMs, params.toMs] } };
    if (params.agentIds.length > 0) filter['agent'] = params.agentIds.map((agent_id) => ({ agent_id }));
    const body: Rec = { filter_criteria: filter, sort_order: 'descending', limit: 1000 };
    if (paginationKey) body['pagination_key'] = paginationKey;

    const res = await requestJson(opts, 'POST', '/v3/list-calls', body);
    if (res.status < 200 || res.status > 299) {
      throw new RetellError(`Listing calls failed (HTTP ${res.status}): ${res.text.slice(0, 200)}`, res.status);
    }

    const items = Array.isArray(res.json) ? res.json : isRec(res.json) && Array.isArray(res.json['items']) ? res.json['items'] : [];
    for (const item of items) {
      if (!isRec(item) || typeof item['call_id'] !== 'string') continue;
      // Filtered here rather than in the request: the status filter's wire shape
      // is not something we could verify, and a wrong guess would silently
      // return nothing. A call that is still in progress has no final log.
      const status = item['call_status'];
      if (typeof status === 'string' && status !== 'ended') continue;
      ids.push(item['call_id']);
      if (ids.length >= params.maxCalls) {
        const more = isRec(res.json) && res.json['has_more'] === true;
        return { ids, truncated: more || items.indexOf(item) < items.length - 1 };
      }
    }

    const hasMore = isRec(res.json) && res.json['has_more'] === true;
    const nextKey = isRec(res.json) && typeof res.json['pagination_key'] === 'string' ? res.json['pagination_key'] : null;
    // A cursor that repeats would loop forever. Stop and report what we have.
    if (!hasMore || !nextKey || seenKeys.has(nextKey)) return { ids, truncated: false };
    seenKeys.add(nextKey);
    paginationKey = nextKey;
  }
  return { ids, truncated: true };
}

export interface FetchCallsResult {
  calls: unknown[];
  /** Call IDs whose detail could not be fetched. Reported, never silently dropped. */
  failed: string[];
  fromCache: number;
  /** Which get-call path answered, for the run log. Null when everything came from cache. */
  detailVersion: 'v2' | 'v1' | null;
}

function cachePath(cacheDir: string | null, callId: string): string | null {
  // A call ID arrives from the network and becomes a file name. Anything that
  // is not a plain token is fetched but never written to disk.
  if (!cacheDir || !SAFE_CALL_ID.test(callId)) return null;
  return join(cacheDir, `${callId}.json`);
}

export async function fetchCalls(opts: RetellClientOptions, ids: string[]): Promise<FetchCallsResult> {
  const slots: unknown[] = new Array<unknown>(ids.length).fill(undefined);
  const failed: string[] = [];
  let fromCache = 0;
  let done = 0;
  let next = 0;
  let detailVersion: 'v2' | 'v1' | null = null;

  if (opts.cacheDir) await mkdir(opts.cacheDir, { recursive: true });

  const getCall = async (id: string): Promise<unknown> => {
    const order: ('v2' | 'v1')[] = detailVersion === 'v1' ? ['v1'] : detailVersion === 'v2' ? ['v2'] : ['v2', 'v1'];
    for (const version of order) {
      const res = await requestJson(opts, 'GET', `/${version}/get-call/${encodeURIComponent(id)}`);
      if (res.status === 404) continue;
      if (res.status < 200 || res.status > 299) {
        throw new RetellError(`Fetching call ${id} failed (HTTP ${res.status}).`, res.status);
      }
      detailVersion = version;
      return res.json;
    }
    return null;
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next;
      next += 1;
      const id = ids[i];
      if (id === undefined) return;

      const file = cachePath(opts.cacheDir, id);
      try {
        let call: unknown = null;
        if (file) {
          try {
            call = JSON.parse(await readFile(file, 'utf8'));
            fromCache += 1;
          } catch {
            call = null;
          }
        }
        if (call === null) {
          call = await getCall(id);
          if (call !== null && file) await writeFile(file, JSON.stringify(call), 'utf8');
        }
        if (call === null) failed.push(id);
        else slots[i] = call;
      } catch (err) {
        // A bad key fails every call the same way. Stop instead of failing 2000 times.
        if (err instanceof RetellError && (err.status === 401 || err.status === 403)) throw err;
        failed.push(id);
      }
      done += 1;
      opts.onProgress?.(done, ids.length);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency, ids.length)) }, () => worker()));
  return { calls: slots.filter((c) => c !== undefined), failed, fromCache, detailVersion };
}
