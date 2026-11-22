import type { Request } from './types';

/** Editable form state for the request drawer. Empty strings stand in for nulls. */
export interface RequestFormState {
  title: string;
  body: string;
  targetRepo: string;
  acceptanceCriteria: string;
  context: string;
  skillsText: string;
  groomed: boolean;
  model: string;
  effort: string;
  kbDigest: boolean;
  cellId: string;
  harness: string;
}

export function formFromRequest(request: Request): RequestFormState {
  return {
    title: request.title,
    body: request.body,
    targetRepo: request.targetRepo ?? '',
    acceptanceCriteria: request.acceptanceCriteria ?? '',
    context: request.context ?? '',
    skillsText: request.skills.join(', '),
    groomed: request.groomed,
    model: request.model ?? '',
    effort: request.effort ?? '',
    kbDigest: request.kbDigest,
    cellId: request.cellId ?? '',
    harness: request.harness ?? '',
  };
}

/** Build the PATCH body; blank strings become nulls so the server can clear fields. */
export function patchFromForm(form: RequestFormState, digest: string): Record<string, unknown> {
  return {
    title: form.title.trim(),
    body: form.body,
    targetRepo: form.targetRepo.trim() || null,
    acceptanceCriteria: form.acceptanceCriteria.trim() === '' ? null : form.acceptanceCriteria,
    context: form.context.trim() === '' ? null : form.context,
    skills: form.skillsText
      .split(',')
      .map((skill) => skill.trim())
      .filter(Boolean),
    groomed: form.groomed,
    model: form.model || null,
    effort: form.effort || null,
    kbDigest: form.kbDigest,
    digest: digest.trim() === '' ? null : digest,
    cellId: form.cellId || null,
    harness: form.harness || null,
  };
}
