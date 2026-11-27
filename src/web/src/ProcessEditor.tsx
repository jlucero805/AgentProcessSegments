import { useState, type ReactNode } from 'react';
import {
  SEGMENT_STATES,
  STATES,
  canTransition,
  isSchedulableSegment,
  type ProcessConfig,
  type SegmentConfig,
} from './types';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  SectionTitle,
  Select,
  Spinner,
  Textarea,
} from './ui';

interface ProcessEditorProps {
  process: ProcessConfig;
  path?: string;
  preservedPath?: string | null;
  saving?: boolean;
  saved?: boolean;
  hideSave?: boolean;
  showPath?: boolean;
  title?: string;
  description?: string;
  onChange: <K extends keyof SegmentConfig>(
    id: SegmentConfig['id'],
    key: K,
    value: SegmentConfig[K],
  ) => void;
  onFollowUp: (
    id: SegmentConfig['id'],
    key: 'enabled' | 'marker',
    value: boolean | string,
  ) => void;
  onSave: () => void;
}

function advanceOptions(segment: SegmentConfig) {
  if (segment.id === 'intake' || segment.id === 'finalize') return [];
  const from = SEGMENT_STATES[segment.id];
  return STATES.filter((state) => canTransition(from, state));
}

/** Native <details> with an initial open state tied to whether the segment is on. */
function SegmentDetails({ open, children }: { open: boolean; children: ReactNode }) {
  const [expanded, setExpanded] = useState(open);
  return (
    <details
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      className="rounded-lg border border-zinc-800 bg-zinc-950/40"
    >
      {children}
    </details>
  );
}

/** Structured editor for process.json; the raw JSON is never shown in the SPA. */
export function ProcessEditor({
  process,
  path = '',
  preservedPath = null,
  saving = false,
  saved = false,
  hideSave = false,
  showPath = true,
  title = 'Process segments',
  description = 'Each segment has a purpose, an idle threshold, a prompt, and an optional marker that advances the request.',
  onChange,
  onFollowUp,
  onSave,
}: ProcessEditorProps) {
  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <SectionTitle>{title}</SectionTitle>
          <p className="mt-1 text-sm text-zinc-500">{description}</p>
        </div>
        {!hideSave ? (
          <div className="flex items-center gap-2">
            {saved ? <span className="text-[11px] text-emerald-400">Saved</span> : null}
            <Button variant="primary" disabled={saving} onClick={onSave}>
              {saving ? <Spinner /> : 'Save process'}
            </Button>
          </div>
        ) : null}
      </div>

      <div className="space-y-2">
        {process.segments.map((segment) => {
          const schedulable = isSchedulableSegment(segment.id);
          return (
            <SegmentDetails key={segment.id} open={schedulable && segment.enabled}>
              <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2">
                <span className="text-sm font-medium text-zinc-200">{segment.label}</span>
                <Badge
                  tone={schedulable && segment.enabled ? 'green' : 'neutral'}
                >
                  {schedulable ? (segment.enabled ? 'on' : 'off') : 'Manual'}
                </Badge>
                <span className="text-[11px] text-zinc-500">
                  {schedulable
                    ? `${segment.idleMinutes}m idle · ${segment.advanceTo ? `→ ${segment.advanceTo}` : 'stays'}${
                        segment.maxConcurrent !== null ? ` · max ${segment.maxConcurrent}` : ''
                      }`
                    : 'never scheduled'}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-600">
                  {segment.purpose}
                </span>
              </summary>

              <div className="space-y-4 border-t border-zinc-800 p-3">
                {schedulable ? null : (
                  <p className="text-xs text-zinc-500">
                    Finalize is manual. The master never schedules a turn here; run
                    Finalize on the request to propose a digest, then index it.
                  </p>
                )}
                <fieldset
                  disabled={!schedulable}
                  className={schedulable ? 'space-y-4' : 'space-y-4 opacity-60'}
                >
                  <Checkbox
                    label={`Automate ${segment.label}`}
                    checked={schedulable && segment.enabled}
                    onChange={(event) =>
                      onChange(segment.id, 'enabled', event.target.checked)
                    }
                  />

                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label="Idle threshold (minutes)">
                      <Input
                        type="number"
                        min={1}
                        max={1440}
                        value={segment.idleMinutes}
                        onChange={(event) =>
                          onChange(segment.id, 'idleMinutes', Number(event.target.value))
                        }
                      />
                    </Field>
                    <Field label="Max per cycle">
                      <Input
                        type="number"
                        min={1}
                        max={50}
                        value={segment.maxPerCycle}
                        onChange={(event) =>
                          onChange(segment.id, 'maxPerCycle', Number(event.target.value))
                        }
                      />
                    </Field>
                    <Field label="Segment concurrency" hint="empty uses cell cap">
                      <Input
                        type="number"
                        min={1}
                        max={50}
                        value={segment.maxConcurrent ?? ''}
                        placeholder="cell cap"
                        onChange={(event) =>
                          onChange(
                            segment.id,
                            'maxConcurrent',
                            event.target.value === '' ? null : Number(event.target.value),
                          )
                        }
                      />
                    </Field>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Label">
                      <Input
                        value={segment.label}
                        onChange={(event) => onChange(segment.id, 'label', event.target.value)}
                      />
                    </Field>
                    <Field label="Advance to" hint="on ready marker">
                      <Select
                        value={segment.advanceTo ?? ''}
                        onChange={(event) =>
                          onChange(
                            segment.id,
                            'advanceTo',
                            event.target.value === ''
                              ? null
                              : (event.target.value as SegmentConfig['advanceTo']),
                          )
                        }
                      >
                        <option value="">Stay in this segment</option>
                        {advanceOptions(segment).map((state) => (
                          <option key={state} value={state}>
                            {state}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>

                  <Field label="Purpose">
                    <Textarea
                      rows={2}
                      value={segment.purpose}
                      onChange={(event) => onChange(segment.id, 'purpose', event.target.value)}
                    />
                  </Field>

                  <Field label="Ready marker" hint="exact line that advances">
                    <Input
                      value={segment.readyMarker ?? ''}
                      placeholder="e.g. READY FOR REVIEW"
                      onChange={(event) =>
                        onChange(segment.id, 'readyMarker', event.target.value || null)
                      }
                    />
                  </Field>

                  <Field label="Agent prompt" hint="empty uses the built-in default">
                    <Textarea
                      rows={5}
                      value={segment.prompt}
                      onChange={(event) => onChange(segment.id, 'prompt', event.target.value)}
                    />
                  </Field>

                  <div className="space-y-2">
                    {segment.id !== 'intake' && segment.id !== 'finalize' ? (
                      <Checkbox
                        label={`Create follow-up requests from ${segment.label} callouts`}
                        checked={segment.followUps.enabled}
                        onChange={(event) =>
                          onFollowUp(segment.id, 'enabled', event.target.checked)
                        }
                      />
                    ) : null}
                    {segment.followUps.enabled && segment.id !== 'intake' && segment.id !== 'finalize' ? (
                      <Field label="Follow-up marker">
                        <Input
                          value={segment.followUps.marker}
                          onChange={(event) =>
                            onFollowUp(segment.id, 'marker', event.target.value)
                          }
                        />
                      </Field>
                    ) : null}
                  </div>
                </fieldset>
              </div>
            </SegmentDetails>
          );
        })}
      </div>

      {preservedPath ? (
        <div
          role="status"
          aria-label="Preserved process file"
          className="space-y-2 rounded-lg border border-zinc-700 bg-zinc-900/60 p-4 text-sm text-zinc-300"
        >
          <p className="font-medium text-zinc-100">
            The unusable process file was preserved
          </p>
          <p className="break-all font-mono text-[11px] text-zinc-400">{preservedPath}</p>
          <p className="text-[11px] text-zinc-500">
            It may contain prompts or policy and is readable only by the account running the
            server. Delete it once you have reviewed it.
          </p>
        </div>
      ) : null}

      {showPath && path ? (
        <p className="break-all font-mono text-[11px] text-zinc-600">{path}</p>
      ) : null}
    </Card>
  );
}
