import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { walkFiles } from '../src/util/files.js';

// Agents treat AGENTS.md as ground truth, so the suite totals are quoted in three
// places and must never drift apart. This guard cannot know how many cases Vitest
// will run without running the suite, so it checks what a test can own: every doc
// quotes the same five numbers, the total adds up, and the quoted file counts match
// the test files on disk. Case counts are refreshed by hand in the commit that
// changes them; verify with `vitest list --json` in `src/server` and `src/web`
// (collected cases include skipped ones).

const repo = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

interface Counts {
  total: number;
  server: number;
  serverFiles: number;
  web: number;
  webFiles: number;
}

interface Doc {
  file: string;
  counts: Counts;
  missing: string[];
  command: { server: number; web: number } | null;
}

const FIELDS: Array<keyof Counts> = ['total', 'server', 'serverFiles', 'web', 'webFiles'];

const TOTAL = /(\d+)\s+vitest cases/;
const SERVER = /(\d+)\s+server\s+(?:cases\s+)?across\s+(\d+)\s+files/;
const WEB = /(\d+)\s+web\s+(?:cases\s+)?across\s+(\d+)\s+files/;
const COMMAND = /npm test\s+#\s+(\d+) server \+ (\d+) web/;

function readDoc(file: string): Doc {
  const text = readFileSync(path.join(repo, file), 'utf8');
  const counts: Counts = { total: 0, server: 0, serverFiles: 0, web: 0, webFiles: 0 };
  const missing: string[] = [];

  const total = TOTAL.exec(text);
  if (total) counts.total = Number(total[1]);
  else missing.push('total vitest cases');

  const server = SERVER.exec(text);
  if (server) {
    counts.server = Number(server[1]);
    counts.serverFiles = Number(server[2]);
  } else missing.push('server cases and files');

  const web = WEB.exec(text);
  if (web) {
    counts.web = Number(web[1]);
    counts.webFiles = Number(web[2]);
  } else missing.push('web cases and files');

  const command = COMMAND.exec(text);
  return {
    file,
    counts,
    missing,
    command: command ? { server: Number(command[1]), web: Number(command[2]) } : null,
  };
}

const docs = ['AGENTS.md', 'README.md', 'docs/02-status.md'].map(readDoc);
const agents = docs[0];

function diskFileCounts(): { serverFiles: number; webFiles: number } {
  const serverFiles = walkFiles(path.join(repo, 'src/server/test')).filter((file) =>
    file.endsWith('.test.ts'),
  ).length;
  const webFiles = walkFiles(path.join(repo, 'src/web/src')).filter((file) =>
    /\.test\.tsx?$/.test(file),
  ).length;
  return { serverFiles, webFiles };
}

describe('documented test totals', () => {
  it('quotes totals, case counts, and file counts in every doc', () => {
    const gaps = docs
      .filter((doc) => doc.missing.length > 0)
      .map((doc) => `${doc.file} is missing: ${doc.missing.join(', ')}`);
    expect(gaps).toEqual([]);
  });

  it('agrees across AGENTS.md, README.md, and docs/02-status.md', () => {
    const base = agents!;
    const problems: string[] = [];
    for (const doc of docs.slice(1)) {
      for (const field of FIELDS) {
        if (doc.counts[field] !== base.counts[field]) {
          problems.push(
            `${doc.file} says ${field}=${doc.counts[field]}, ${base.file} says ${base.counts[field]}`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('adds up to the total', () => {
    const problems = docs
      .filter((doc) => doc.counts.total !== doc.counts.server + doc.counts.web)
      .map(
        (doc) =>
          `${doc.file} total ${doc.counts.total} != ${doc.counts.server} + ${doc.counts.web}`,
      );
    expect(problems).toEqual([]);
  });

  it('matches the test files on disk', () => {
    const disk = diskFileCounts();
    const problems: string[] = [];
    for (const doc of docs) {
      if (doc.counts.serverFiles !== disk.serverFiles) {
        problems.push(
          `${doc.file} says ${doc.counts.serverFiles} server files; disk has ${disk.serverFiles}`,
        );
      }
      if (doc.counts.webFiles !== disk.webFiles) {
        problems.push(
          `${doc.file} says ${doc.counts.webFiles} web files; disk has ${disk.webFiles}`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it('keeps the npm test command comment in step', () => {
    const base = agents!;
    expect(base.command).toEqual({ server: base.counts.server, web: base.counts.web });
  });
});
