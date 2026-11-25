import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, describeError } from './api';
import type { PluginInfo } from './types';
import { Badge, Button, Card, EmptyState, Field, Input, SectionTitle, Spinner } from './ui';

interface SkillsPageProps {
  onError: (message: string) => void;
}

/** Installs, lists, and removes skill/command plugins. */
export function SkillsPage({ onError }: SkillsPageProps) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [url, setUrl] = useState('');
  const [subdir, setSubdir] = useState('');
  const [installing, setInstalling] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPlugins(await api.getPlugins());
    } catch (error) {
      onError(describeError(error));
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  async function install(event: FormEvent) {
    event.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    setInstalling(true);
    try {
      await api.installPlugin({
        url: trimmed,
        subdir: subdir.trim() || undefined,
      });
      setUrl('');
      setSubdir('');
      await load();
    } catch (error) {
      onError(describeError(error));
    } finally {
      setInstalling(false);
    }
  }

  async function remove(name: string) {
    setRemoving(name);
    try {
      await api.removePlugin(name);
      await load();
    } catch (error) {
      onError(describeError(error));
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className="mx-auto h-full w-full max-w-4xl overflow-y-auto p-6">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-zinc-100">Skills and commands</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Plugins contribute skills and slash commands to agent sessions. Hooks and MCP servers in
          a plugin are stripped on install.
        </p>
      </div>

      <Card className="mb-6 p-4">
        <SectionTitle className="mb-3">Install from a git source</SectionTitle>
        <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={install}>
          <div className="flex-1">
            <Field label="URL or local path">
              <Input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://github.com/owner/plugin.git"
              />
            </Field>
          </div>
          <div className="w-full sm:w-48">
            <Field label="Subdir" hint="monorepo">
              <Input
                value={subdir}
                onChange={(event) => setSubdir(event.target.value)}
                placeholder="optional"
              />
            </Field>
          </div>
          <Button type="submit" variant="primary" disabled={installing || url.trim() === ''}>
            {installing ? <Spinner /> : 'Install'}
          </Button>
        </form>
      </Card>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Spinner /> Loading plugins...
        </div>
      ) : plugins.length === 0 ? (
        <EmptyState title="No plugins installed" hint="Install a plugin to add skills and commands." />
      ) : (
        <div className="space-y-2">
          {plugins.map((plugin) => (
            <Card key={plugin.name} className="flex items-start justify-between gap-4 p-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-zinc-200">{plugin.name}</span>
                  <Badge tone="purple">plugin</Badge>
                </div>
                <p className="mt-1 text-sm text-zinc-400">{plugin.description || 'No description.'}</p>
                <p className="mt-1 truncate font-mono text-[11px] text-zinc-600">{plugin.dir}</p>
              </div>
              <Button
                variant="danger"
                size="sm"
                disabled={removing === plugin.name}
                onClick={() => void remove(plugin.name)}
              >
                {removing === plugin.name ? <Spinner /> : 'Remove'}
              </Button>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
