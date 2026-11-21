import { useEffect, useState } from 'react';
import { api, describeError } from './api';
import { ProcessEditor } from './ProcessEditor';
import {
  EFFORT_LEVELS,
  type CellDetail,
  type ModelOption,
  type ProcessConfig,
  type SegmentConfig,
} from './types';
import { Button, Field, Input, Modal, Select, Spinner } from './ui';

interface CellModalProps {
  open: boolean;
  /** null creates a new cell; a cell edits it. */
  cell: CellDetail | null;
  onClose: () => void;
  onSaved: (cell: CellDetail) => void;
  onError: (message: string) => void;
}

/**
 * The cell creation flow: name plus a complete process policy, seeded from the
 * global default. This is where an operator decides what the cell's master should
 * push toward before the cell has any requests.
 */
export function CellModal({ open, cell, onClose, onSaved, onError }: CellModalProps) {
  const [name, setName] = useState('');
  const [interval, setInterval] = useState('');
  const [maxConcurrent, setMaxConcurrent] = useState('3');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [efforts, setEfforts] = useState<readonly string[]>(EFFORT_LEVELS);
  const [supportsEffort, setSupportsEffort] = useState(true);
  const [process, setProcess] = useState<ProcessConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const key = cell?.id ?? 'new';

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setName(cell?.name ?? '');
    setInterval(cell?.masterIntervalMinutes ? String(cell.masterIntervalMinutes) : '');
    setMaxConcurrent(String(cell?.maxConcurrent ?? 3));
    setModel(cell?.model ?? '');
    setEffort(cell?.effort ?? '');
    setProcess(cell?.process ?? null);
    setLoading(cell?.process == null);
    setSaving(false);

    api
      .getModels()
      .then((result) => {
        if (cancelled) return;
        setModels(Array.isArray(result.models) ? result.models : []);
        setEfforts(
          Array.isArray(result.effortLevels) && result.effortLevels.length > 0
            ? result.effortLevels
            : EFFORT_LEVELS,
        );
        setSupportsEffort(result.supportsEffort !== false);
      })
      .catch(() => {
        // Model discovery is optional; the CLI default remains usable.
      });

    if (cell?.process == null) {
      api
        .getProcess()
        .then((global) => {
          if (!cancelled) setProcess({ version: global.version, segments: global.segments });
        })
        .catch((error) => {
          if (!cancelled) onError(describeError(error));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [open, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const setSegment = <K extends keyof SegmentConfig>(
    id: SegmentConfig['id'],
    field: K,
    value: SegmentConfig[K],
  ) => {
    setProcess((current) =>
      current
        ? {
            ...current,
            segments: current.segments.map((segment) =>
              segment.id === id ? { ...segment, [field]: value } : segment,
            ),
          }
        : current,
    );
  };

  const setFollowUp = (
    id: SegmentConfig['id'],
    field: 'enabled' | 'marker',
    value: boolean | string,
  ) => {
    setProcess((current) =>
      current
        ? {
            ...current,
            segments: current.segments.map((segment) =>
              segment.id === id
                ? { ...segment, followUps: { ...segment.followUps, [field]: value } }
                : segment,
            ),
          }
        : current,
    );
  };

  async function resetToDefault() {
    setLoading(true);
    try {
      const global = await api.getProcess();
      setProcess({ version: global.version, segments: global.segments });
    } catch (error) {
      onError(describeError(error));
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    const trimmed = name.trim();
    if (trimmed === '') {
      onError('A cell name is required.');
      return;
    }
    if (!process) {
      onError('The process is still loading.');
      return;
    }
    const minutes = interval.trim() === '' ? null : Number(interval);
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)) {
      onError('The master interval must be a whole number from 1 to 1440, or empty to inherit.');
      return;
    }
    const concurrency = Number(maxConcurrent);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 50) {
      onError('Max concurrent requests must be a whole number from 1 to 50.');
      return;
    }
    setSaving(true);
    try {
      const fields = {
        name: trimmed,
        process,
        masterIntervalMinutes: minutes,
        maxConcurrent: concurrency,
        model: model || null,
        effort: effort || null,
      };
      const saved = cell
        ? await api.patchCell(cell.id, fields)
        : await api.createCell(fields);
      onSaved(saved);
    } catch (error) {
      onError(describeError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={cell ? 'Edit cell' : 'New cell'}
      wide
    >
      <div className="max-h-[75vh] space-y-4 overflow-y-auto pr-1">
        <Field label="Cell name">
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Work repo"
          />
        </Field>

        <Field label="Master interval (minutes)" hint="empty uses the global cadence">
          <Input
            type="number"
            min={1}
            max={1440}
            value={interval}
            onChange={(event) => setInterval(event.target.value)}
            placeholder="global default"
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Max concurrent requests" hint="working processes in this cell">
            <Input
              type="number"
              min={1}
              max={50}
              value={maxConcurrent}
              onChange={(event) => setMaxConcurrent(event.target.value)}
            />
          </Field>
          <Field label="Default model" hint="request override wins">
            <Select value={model} onChange={(event) => setModel(event.target.value)}>
              <option value="">CLI default</option>
              {models.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field
          label="Default difficulty"
          hint={supportsEffort ? 'request override wins' : 'not used by this harness'}
        >
          {supportsEffort ? (
            <Select value={effort} onChange={(event) => setEffort(event.target.value)}>
              <option value="">CLI default</option>
              {efforts.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </Select>
          ) : (
            <Input value="—" disabled readOnly />
          )}
        </Field>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-zinc-500">
            Define the process before the cell receives work. New cells start from the
            global template.
          </p>
          <Button variant="ghost" size="sm" onClick={() => void resetToDefault()}>
            Reset to global default
          </Button>
        </div>

        {loading || !process ? (
          <div className="flex h-32 items-center justify-center gap-2 text-sm text-zinc-500">
            <Spinner /> Loading process...
          </div>
        ) : (
          <ProcessEditor
            process={process}
            hideSave
            showPath={false}
            title="Cell process segments"
            description="These prompts and rules belong to this cell's master. Review and finalize defaults remain conservative."
            onChange={setSegment}
            onFollowUp={setFollowUp}
            onSave={() => {}}
          />
        )}
      </div>

      <div className="mt-4 flex justify-end gap-2 border-t border-zinc-800 pt-3">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={saving || loading || !process}
          onClick={() => void save()}
        >
          {saving ? <Spinner /> : cell ? 'Save cell' : 'Create cell'}
        </Button>
      </div>
    </Modal>
  );
}
