import { describe, expect, it } from 'vitest';
import { formFromRequest, patchFromForm } from './requestForm';
import { makeRequest } from './test/fixtures';

describe('request form mapping', () => {
  it('round-trips nullable fields through blank form values', () => {
    const form = formFromRequest(
      makeRequest({
        title: ' Build it ',
        targetRepo: '/repo',
        acceptanceCriteria: null,
        context: 'why',
        skills: ['tdd', 'release'],
        model: 'm1',
        effort: 'high',
        cellId: 'c1',
      }),
    );

    expect(form).toMatchObject({
      targetRepo: '/repo',
      acceptanceCriteria: '',
      skillsText: 'tdd, release',
      effort: 'high',
      cellId: 'c1',
    });

    expect(patchFromForm(form, '  ')).toEqual({
      title: 'Build it',
      body: '',
      targetRepo: '/repo',
      acceptanceCriteria: null,
      context: 'why',
      skills: ['tdd', 'release'],
      groomed: false,
      model: 'm1',
      effort: 'high',
      kbDigest: true,
      digest: null,
      cellId: 'c1',
    });
  });

  it('clears blank nullable fields and normalizes skills', () => {
    const form = formFromRequest(makeRequest({ targetRepo: null, skills: [] }));
    form.targetRepo = '  ';
    form.skillsText = ' alpha, , beta ';

    const patch = patchFromForm(form, ' digest ');
    expect(patch).toMatchObject({
      targetRepo: null,
      acceptanceCriteria: null,
      context: null,
      skills: ['alpha', 'beta'],
      model: null,
      effort: null,
      cellId: null,
      digest: ' digest ',
    });
  });
});
