// Idempotent removal of the request and cell created by scripts/ui-smoke.mjs.
//
// The smoke captures ids from the create responses, but an early failure can land
// before the response is read. In that case the artifacts are found by their fixed
// names, minus the ids that existed before the run. A missing baseline disables
// that fallback so cleanup can never delete an artifact it did not create.
const CLEANUP_TIMEOUT_MS = 5_000;

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {object} options
 * @param {string} options.base Running brain URL, without a trailing slash required.
 * @param {{ id?: string, title: string }} [options.request]
 * @param {{ id?: string, name: string }} [options.cell]
 * @param {Set<string> | string[] | null} [options.baselineRequestIds]
 * @param {Set<string> | string[] | null} [options.baselineCellIds]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{ failures: Array<{ kind: string, id: string | null, message: string }> }>}
 */
export async function cleanupUiSmokeArtifacts({
  base,
  request,
  cell,
  baselineRequestIds = null,
  baselineCellIds = null,
  fetchImpl = fetch,
  log = () => {},
} = {}) {
  const failures = [];
  const root = String(base ?? '').replace(/\/+$/, '');
  const knownRequests = baselineRequestIds === null ? null : new Set(baselineRequestIds);
  const knownCells = baselineCellIds === null ? null : new Set(baselineCellIds);

  const fail = (kind, id, error) => {
    const message = describe(error);
    failures.push({ kind, id: id ?? null, message });
    log(`ui smoke cleanup failed: ${kind}${id ? ` ${id}` : ''}: ${message}`);
  };

  async function requestJson(path) {
    const response = await fetchImpl(`${root}${path}`, {
      signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GET ${path} -> ${response.status}`);
    return response.json();
  }

  async function send(method, path) {
    const response = await fetchImpl(`${root}${path}`, {
      method,
      signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`${method} ${path} -> ${response.status}`);
    }
  }

  async function resolveIds({ id, kind, matches, listPath, baseline }) {
    if (id) return [id];
    if (baseline === null) {
      fail(kind, null, 'no pre-run baseline; refusing to match by name');
      return [];
    }
    try {
      const items = await requestJson(listPath);
      return items
        .filter((item) => matches(item) && !baseline.has(item.id))
        .map((item) => item.id);
    } catch (error) {
      fail(kind, null, error);
      return [];
    }
  }

  try {
    const requestIds = request
      ? await resolveIds({
          id: request.id,
          kind: 'request',
          matches: (item) => item.title === request.title,
          listPath: '/api/requests',
          baseline: knownRequests,
        })
      : [];
    const cellIds = cell
      ? await resolveIds({
          id: cell.id,
          kind: 'cell',
          matches: (item) => item.name === cell.name,
          listPath: '/api/cells',
          baseline: knownCells,
        })
      : [];

    for (const id of requestIds) {
      try {
        await send('POST', `/api/requests/${encodeURIComponent(id)}/drop`);
      } catch (error) {
        fail('request', id, error);
      }
    }
    for (const id of cellIds) {
      try {
        await send('DELETE', `/api/cells/${encodeURIComponent(id)}`);
      } catch (error) {
        fail('cell', id, error);
      }
    }
  } catch (error) {
    // The helper is called from finally and signal handlers, so it must never throw.
    fail('cleanup', null, error);
  }

  return { failures };
}
