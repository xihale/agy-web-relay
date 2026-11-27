import fs from 'node:fs';
import path from 'node:path';

const USAGE_HASH_RE = /^[a-f0-9]{64}$/;
const USAGE_JSON_FILE_RE = /^[a-f0-9]{64}\.json$/;
const USAGE_SQLITE_FILE_RE = /^[a-f0-9]{64}\.sqlite$/;
const USAGE_TOKEN_KEYS = ['uncached', 'cacheRead', 'cacheWrite', 'output'];

function isValidUsageRow(r) {
  return (
    r &&
    USAGE_HASH_RE.test(r.id) &&
    typeof r.model === 'string' &&
    r.model.length <= 120 &&
    (r.at === null || (Number.isSafeInteger(r.at) && r.at >= 0)) &&
    USAGE_TOKEN_KEYS.every((k) => r[k] === null || (Number.isSafeInteger(r[k]) && r[k] >= 0))
  );
}

function usageRowSum(r) {
  return (r.uncached ?? 0) + (r.cacheRead ?? 0) + (r.cacheWrite ?? 0) + (r.output ?? 0);
}

function isoWeekStart(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function createFastUsageReader({ directory, timeZone = 'Asia/Shanghai', source = 'desktop-local' } = {}) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const dateBucketCache = new Map();
  const formatDateKey = (ms) => {
    const bucket = Math.floor(ms / 60_000);
    const cached = dateBucketCache.get(bucket);
    if (cached !== undefined) return cached;
    const formatted = fmt.format(ms);
    let key = formatted;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(formatted)) {
      const parts = fmt.formatToParts(ms);
      const get = (type) => parts.find((p) => p.type === type)?.value || '';
      key = `${get('year')}-${get('month')}-${get('day')}`;
    }
    if (dateBucketCache.size >= 4096) dateBucketCache.clear();
    dateBucketCache.set(bucket, key);
    return key;
  };

  const jsonCache = new Map();
  let jsonCacheScope = null;
  const summaryCache = new Map();
  const inFlight = new Map();
  const SWR_TTL_MS = 15_000;
  const yieldToLoop = () => new Promise((r) => setImmediate(r));

  const computeSummary = async (scope, now) => {
    if (!directory || !scope || !USAGE_HASH_RE.test(scope)) return null;
    const today = formatDateKey(now);
    const scopeDir = path.join(directory, scope);
    let files = [];
    try {
      files = await fs.promises.readdir(scopeDir);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (files.some((name) => USAGE_SQLITE_FILE_RE.test(name))) {
      return null;
    }

    const jsonNames = files.filter((name) => USAGE_JSON_FILE_RE.test(name));
    if (jsonCacheScope !== scope) {
      jsonCache.clear();
      jsonCacheScope = scope;
    }
    const present = new Set(jsonNames);
    for (const cachedName of jsonCache.keys()) {
      if (!present.has(cachedName)) jsonCache.delete(cachedName);
    }

    const seen = new Map();
    let unreadable = 0;
    let fileCount = 0;
    let rowCount = 0;

    for (const name of jsonNames) {
      fileCount++;
      if (fileCount % 64 === 0) await yieldToLoop();
      const fullPath = path.join(scopeDir, name);
      try {
        const info = await fs.promises.lstat(fullPath, { bigint: true });
        if (info.isSymbolicLink() || !info.isFile()) throw new Error('Invalid ledger');
        const stamp = `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}`;
        let records = null;
        const hit = jsonCache.get(name);
        if (hit && hit.stamp === stamp) {
          records = hit.records;
        } else {
          const text = await fs.promises.readFile(fullPath, 'utf8');
          const record = JSON.parse(text);
          if (
            !record ||
            record.schema !== 1 ||
            record.account !== scope ||
            !Array.isArray(record.records) ||
            !record.records.every(isValidUsageRow)
          ) {
            throw new Error('Invalid ledger');
          }
          records = record.records;
          jsonCache.set(name, { stamp, records });
          while (jsonCache.size > 4096) jsonCache.delete(jsonCache.keys().next().value);
        }
        for (const r of records) {
          rowCount++;
          if (rowCount % 8000 === 0) await yieldToLoop();
          const previous = seen.get(r.id);
          if (!previous || usageRowSum(r) > usageRowSum(previous)) {
            seen.set(r.id, r);
          }
        }
      } catch {
        jsonCache.delete(name);
        unreadable++;
      }
    }

    const daily = new Map();
    const models = new Set();
    let unknownTokens = 0;
    let unknownRequests = 0;
    let partialRequests = 0;

    for (const r of seen.values()) {
      rowCount++;
      if (rowCount % 8000 === 0) await yieldToLoop();
      models.add(r.model);
      if (r.partial) partialRequests++;
      const rowTotal = usageRowSum(r);
      if (r.at === null) {
        unknownTokens += rowTotal;
        unknownRequests++;
        continue;
      }
      const date = formatDateKey(r.at);
      let day = daily.get(date);
      if (!day) {
        day = { date, models: {} };
        daily.set(date, day);
      }
      let bucket = day.models[r.model];
      if (!bucket) {
        bucket = { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, requests: 0 };
        day.models[r.model] = bucket;
      }
      for (const key of USAGE_TOKEN_KEYS) bucket[key] += r[key] ?? 0;
      bucket.total += rowTotal;
      bucket.requests++;
    }

    const days = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
    const dayTotal = (day) => Object.values(day.models).reduce((n, r) => n + r.total, 0);
    const weekStartDate = isoWeekStart(today);
    const monthPrefix = today.slice(0, 7);

    return {
      accountKey: scope,
      timeZone,
      today,
      days,
      models: [...models].sort(),
      todayTokens: days.filter((d) => d.date === today).reduce((n, d) => n + dayTotal(d), 0),
      weekTokens: days.filter((d) => d.date >= weekStartDate && d.date <= today).reduce((n, d) => n + dayTotal(d), 0),
      monthTokens: days
        .filter((d) => d.date.slice(0, 7) === monthPrefix && d.date <= today)
        .reduce((n, d) => n + dayTotal(d), 0),
      totalTokens: days.reduce((n, d) => n + dayTotal(d), 0) + unknownTokens,
      unknownTokens,
      unknownRequests,
      partialRequests,
      unreadableFiles: unreadable,
      requests: seen.size,
      firstDate: days[0]?.date || null,
      updatedAt: new Date(now).toISOString(),
      source,
    };
  };

  const refresh = (scope, now, cacheKey) => {
    const existing = inFlight.get(cacheKey);
    if (existing) return existing;
    const p = computeSummary(scope, now)
      .then((value) => {
        if (value === null) {
          summaryCache.delete(cacheKey);
          return null;
        }
        if (summaryCache.size >= 16 && !summaryCache.has(cacheKey)) {
          summaryCache.delete(summaryCache.keys().next().value);
        }
        summaryCache.set(cacheKey, { value, cachedAt: Date.now() });
        return value;
      })
      .finally(() => {
        if (inFlight.get(cacheKey) === p) inFlight.delete(cacheKey);
      });
    inFlight.set(cacheKey, p);
    return p;
  };

  const summary = async (scope, now = Date.now(), { forceRefresh = false } = {}) => {
    if (!directory || !scope || !USAGE_HASH_RE.test(scope)) return null;
    const today = formatDateKey(now);
    const cacheKey = `${scope}:${today}`;
    const cached = summaryCache.get(cacheKey);
    if (cached && !forceRefresh) {
      const age = Date.now() - cached.cachedAt;
      if (age > SWR_TTL_MS && !inFlight.has(cacheKey)) {
        refresh(scope, now, cacheKey).catch(() => {});
      }
      return cached.value;
    }
    return refresh(scope, now, cacheKey);
  };

  return { summary, formatDateKey };
}
