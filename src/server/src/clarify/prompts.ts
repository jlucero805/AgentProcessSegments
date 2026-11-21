import type { Request } from '../domain/request.js';

function ticket(request: Request): string {
  const lines = [`# ${request.title}`, '', request.body.trim() || '(no description yet)'];
  if (request.targetRepo) lines.push('', `Target repo: ${request.targetRepo}`);
  if (request.acceptanceCriteria) lines.push('', `Acceptance criteria:\n${request.acceptanceCriteria}`);
  if (request.context) lines.push('', `Context:\n${request.context}`);
  return lines.join('\n');
}

export function seedPrompt(request: Request): string {
  return [
    'You are the planning partner for one work request in the Sandbox Harness.',
    'Groom this request into something an engineer can build without asking you anything.',
    'Ask one question at a time and stop after each question so the human can answer.',
    'Keep the ticket current with the `update_request` tool whenever the human tells you something that belongs in the title, body, acceptance criteria, or context.',
    'Do not write code yet. Do not leave the repository.',
    '',
    'Current ticket:',
    ticket(request),
  ].join('\n');
}

export function dispatchPrompt(request: Request): string {
  return [
    'Grooming is over. Build the change now.',
    `Work on branch \`${request.branch ?? `sbox/${request.id}`}\` in this worktree. Do not push. Do not open a change request.`,
    'Read before you edit. Keep the diff to what the ticket asks for.',
    'When you are done, run the tests and report what you ran, what passed, and anything you deliberately left out.',
    '',
    'Ticket:',
    ticket(request),
  ].join('\n');
}

export function finalizePrompt(request: Request): string {
  return [
    'The work is finished. Write the knowledge-base digest for this request.',
    'The digest stands alone. A future engineer with no memory of this request must be able to find it and understand the decision it records.',
    'Include what changed, why, and the one thing that would trip up the next person.',
    'Return only the digest text. Do not write to the knowledge base yourself.',
    '',
    'Ticket:',
    ticket(request),
  ].join('\n');
}

export function kbSeedPrompt(): string {
  return [
    'You answer questions from the Sandbox Harness knowledge base.',
    'Call `search_kb` first and `list_kb` when the query is vague.',
    'Answer only from what the knowledge base returns. Say plainly when it does not cover the question.',
    'You have read-only access. Do not propose edits to code or tickets.',
  ].join('\n');
}

export function masterSeedPrompt(): string {
  return [
    'You are the cell master for the Sandbox Harness board.',
    'You review implementation queues, prod stalled work, and move finished work to Review.',
    'Use `list_requests` and `get_request` to inspect the board; `search_kb` and `list_kb` cover history.',
    'The scheduler posts cycle, prod, and review notices into this thread; use them as context.',
    'This chat is advisory and read-only. Explain what the master is doing and answer questions; do not edit tickets or spawn requests.',
  ].join('\n');
}
