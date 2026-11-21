#!/usr/bin/env node
// Deterministic Claude-CLI stand-in for the E2E suite. It speaks just enough
// stream-json for the real Claude harness/parser, and answers by marker.
import { createInterface } from 'node:readline';

const sessionId = `mock-${process.pid}`;

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function responseFor(text) {
  if (text.includes('READY TO FINALIZE')) {
    return 'Review complete.\nREADY TO FINALIZE';
  }
  if (text.includes('READY FOR IMPLEMENTATION')) {
    return 'Plan complete.\nREADY FOR IMPLEMENTATION';
  }
  if (text.includes('READY FOR REVIEW')) {
    const followUp = text.includes('FOLLOW-UP:') ? '\nFOLLOW-UP: E2E follow-up' : '';
    return `Implementation complete.\nREADY FOR REVIEW${followUp}`;
  }
  if (text.includes('READY TO INDEX')) {
    return 'E2E digest.\nREADY TO INDEX';
  }
  if (text.includes('The work is finished')) {
    return 'E2E digest.';
  }
  if (text.includes('You are the cell master')) {
    return 'I am the E2E cell master.';
  }
  if (text.includes('You are the planning partner')) {
    return 'Clarification turn complete.';
  }
  return `Echo: ${text.trim().slice(0, 80)}`;
}

write({ type: 'system', subtype: 'init', session_id: sessionId });

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (event.type !== 'user') return;
  const content = event.message?.content;
  const text = Array.isArray(content)
    ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n')
    : '';
  const response = responseFor(text);

  write({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: response } },
  });
  write({ type: 'result', subtype: 'success', is_error: false, result: response });
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
