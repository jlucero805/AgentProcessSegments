// Suite registry for scripts/web-stress.mjs. Pure: no globals, no I/O.
//
// Both suites share the same run loop, report parser, and hog lifecycle; only
// the workspace, operator label, log prefix, and hog marker differ. Keeping the
// mapping here means the entry and its guard read one source of truth.
export const SUITES = Object.freeze({
  web: Object.freeze({
    workspace: 'src/web',
    label: 'web-stress',
    logPrefix: 'aps-web-stress-',
    hogMarker: 'aps-web-stress-hog',
  }),
  server: Object.freeze({
    workspace: 'src/server',
    label: 'server-stress',
    logPrefix: 'aps-server-stress-',
    hogMarker: 'aps-server-stress-hog',
  }),
});

export const SUITE_NAMES = Object.freeze(Object.keys(SUITES));

/** The npm argv for one full-suite iteration of `suite`. */
export function suiteArgs(suite, { resultsPath, only = [] }) {
  if (suite === null || typeof suite !== 'object' || typeof suite.workspace !== 'string') {
    throw new TypeError('suiteArgs needs a suite with a workspace');
  }
  return [
    'test',
    '--workspace',
    suite.workspace,
    '--',
    '--reporter=verbose',
    '--reporter=json',
    `--outputFile.json=${resultsPath}`,
    ...only,
  ];
}
