import { useState, type FormEvent } from 'react';
import { api, describeError } from './api';
import { Button, Field, Input, Modal, Spinner, Textarea } from './ui';

interface CreateModalProps {
  open: boolean;
  onClose: () => void;
  cellId: string | null;
  onCreated: (id: string) => void;
  onError: (message: string) => void;
}

export function CreateModal({ open, onClose, cellId, onCreated, onError }: CreateModalProps) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [targetRepo, setTargetRepo] = useState('');
  const [saving, setSaving] = useState(false);
  // Clear the fields on the open→closed edge so the next open starts empty.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) {
      setTitle('');
      setBody('');
      setTargetRepo('');
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) {
      onError('A title is required.');
      return;
    }
    setSaving(true);
    try {
      const created = await api.createRequest({
        title: trimmed,
        body,
        targetRepo: targetRepo.trim() || null,
        cellId,
      });
      onCreated(created.id);
    } catch (error) {
      onError(describeError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New request">
      <form className="space-y-4" onSubmit={submit}>
        <Field label="Title">
          <Input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What should the agent do?"
          />
        </Field>
        <Field label="Body" hint="optional">
          <Textarea
            rows={5}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Context, links, constraints, and what done looks like."
          />
        </Field>
        <Field label="Target repo" hint="optional">
          <Input
            value={targetRepo}
            onChange={(event) => setTargetRepo(event.target.value)}
            placeholder="/path/to/repo or git URL"
          />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? <Spinner /> : 'Create request'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
