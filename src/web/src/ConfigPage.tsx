import { useCallback, useEffect, useState } from 'react';
import { api, describeError } from './api';
import type { MasterConfig } from './types';
import {
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  SectionTitle,
  Spinner,
  Textarea,
} from './ui';

interface ConfigPageProps {
  onError: (message: string) => void;
}

/** Edits the persisted master policy in the XDG config file. */
export function ConfigPage({ onError }: ConfigPageProps) {
  const [master, setMaster] = useState<MasterConfig | null>(null);
  const [path, setPath] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const config = await api.getConfig();
      setMaster(config.master);
      setPath(config.path);
    } catch (error) {
      onError(describeError(error));
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const set = <K extends keyof MasterConfig>(key: K, value: MasterConfig[K]) => {
    setMaster((current) => (current ? { ...current, [key]: value } : current));
    setSaved(false);
  };

  async function save() {
    if (!master) return;
    setSaving(true);
    try {
      const config = await api.patchConfig(master);
      setMaster(config.master);
      setPath(config.path);
      setSaved(true);
    } catch (error) {
      onError(describeError(error));
    } finally {
      setSaving(false);
    }
  }

  if (!master) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-zinc-500">
        <Spinner /> Loading settings...
      </div>
    );
  }

  return (
    <div className="mx-auto h-full w-full max-w-3xl overflow-y-auto p-4 md:p-6">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-zinc-100">Cell master</h1>
        <p className="mt-1 text-sm text-zinc-500">
          The master reviews each cell&apos;s implementation queue on a cadence, prods
          stalled agents to record decisions and keep moving, and can move completed work
          to Review.
        </p>
      </div>

      <Card className="space-y-5 p-4">
        <SectionTitle>Policy</SectionTitle>

        <Checkbox
          label="Master enabled"
          checked={master.enabled}
          onChange={(event) => set('enabled', event.target.checked)}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Interval (minutes)" hint="how often to review">
            <Input
              type="number"
              min={1}
              max={1440}
              value={master.intervalMinutes}
              onChange={(event) => set('intervalMinutes', Number(event.target.value))}
            />
          </Field>
          <Field label="Idle threshold (minutes)" hint="prod after this long">
            <Input
              type="number"
              min={1}
              max={1440}
              value={master.idleMinutes}
              onChange={(event) => set('idleMinutes', Number(event.target.value))}
            />
          </Field>
        </div>

        <div className="space-y-2">
          <Checkbox
            label="Move to Review when the agent ends with READY FOR REVIEW"
            checked={master.autoReview}
            onChange={(event) => set('autoReview', event.target.checked)}
          />
          <Checkbox
            label="Include requests without a cell"
            checked={master.includeUnassigned}
            onChange={(event) => set('includeUnassigned', event.target.checked)}
          />
        </div>

        <Field label="Prod prompt" hint="sent to stalled implementation sessions">
          <Textarea
            rows={10}
            value={master.prompt}
            onChange={(event) => set('prompt', event.target.value)}
          />
        </Field>

        <div className="flex flex-col gap-3 border-t border-zinc-800 pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="break-all font-mono text-[11px] text-zinc-600">{path}</p>
          <div className="flex items-center justify-end gap-2">
            {saved ? <span className="text-[11px] text-emerald-400">Saved</span> : null}
            <Button variant="primary" disabled={saving} onClick={() => void save()}>
              {saving ? <Spinner /> : 'Save settings'}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
