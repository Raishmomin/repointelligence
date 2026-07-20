import { useEffect, useState } from 'react';
import type {
  ListModelsParams,
  ProviderSummaryDto,
  SaveParams,
  ValidateParams,
} from '@shared/webview.types';
import type { ProviderOption, WireProviderField } from '@providers/descriptor.types';
import { isFieldVisible, validateFieldFormat } from '@providers/descriptor.types';
import { rpc } from '../messaging/rpc';

type Draft = Record<string, string | number | undefined>;

interface Props {
  onClose(): void;
  onSaved(): void;
}

/**
 * Add or reconfigure a model provider.
 *
 * Every field rendered here comes from the provider's descriptor, so a new provider needs
 * no change in this file.
 */
export function ProviderPanel({ onClose, onSaved }: Props) {
  const [providers, setProviders] = useState<ProviderSummaryDto[] | undefined>();
  const [selected, setSelected] = useState<ProviderSummaryDto | undefined>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    rpc<ProviderSummaryDto[]>('providers:list', {})
      .then(setProviders)
      .catch((cause: Error) => setError(cause.message));
  }, []);

  if (error) {
    return (
      <Panel title="Model providers" onClose={onClose}>
        <p className="panel-error">{error}</p>
      </Panel>
    );
  }

  if (!providers) {
    return (
      <Panel title="Model providers" onClose={onClose}>
        <p className="panel-hint">Loading…</p>
      </Panel>
    );
  }

  if (selected) {
    return (
      <ProviderForm
        provider={selected}
        onBack={() => setSelected(undefined)}
        onClose={onClose}
        onSaved={onSaved}
      />
    );
  }

  return (
    <Panel title="Model providers" onClose={onClose}>
      <p className="panel-hint">Pick a platform to configure. Keys are stored in your OS keychain.</p>
      <div className="provider-list">
        {providers.map((provider) => (
          <button
            key={provider.schema.id}
            type="button"
            className="provider-row"
            onClick={() => setSelected(provider)}
          >
            <div className="provider-row-main">
              <span className="provider-row-label">{provider.schema.label}</span>
              {provider.configured ? (
                <span className="provider-badge provider-badge-ok">configured</span>
              ) : (
                <span className="provider-badge">not set up</span>
              )}
            </div>
            <span className="provider-row-detail">
              {provider.schema.detail ?? provider.schema.description}
            </span>
          </button>
        ))}
      </div>
    </Panel>
  );
}

function ProviderForm({
  provider,
  onBack,
  onClose,
  onSaved,
}: {
  provider: ProviderSummaryDto;
  onBack(): void;
  onClose(): void;
  onSaved(): void;
}) {
  // Secrets live only here, in component state. They are deliberately never written to
  // vscode.setState(), which is disk-backed — a key persisted there would outlive the
  // session on disk.
  const [draft, setDraft] = useState<Draft>(() => ({ ...provider.values }));
  const [models, setModels] = useState<ProviderOption[]>([]);
  const [modelsError, setModelsError] = useState<string>();
  const [busy, setBusy] = useState<'models' | 'saving' | undefined>();
  const [status, setStatus] = useState<string>();

  const fields = provider.schema.fields.filter((field) => isFieldVisible(field, draft));
  const modelField = fields.find((field) => field.kind === 'model');

  const loadModels = async () => {
    if (!modelField) return;
    setBusy('models');
    setModelsError(undefined);
    try {
      const result = await rpc<{ options: ProviderOption[]; error?: string }>(
        'providers:listModels',
        { providerId: provider.schema.id, fieldId: modelField.id, draft } satisfies ListModelsParams,
      );
      setModels(result.options);
      if (result.error) setModelsError(result.error);
    } catch (cause) {
      setModelsError((cause as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const save = async () => {
    setBusy('saving');
    setStatus(undefined);
    try {
      const validation = await rpc<{ ok: boolean; message?: string }>('providers:validate', {
        providerId: provider.schema.id,
        draft,
      } satisfies ValidateParams);

      if (!validation.ok) {
        // Saving anyway is legitimate — the server may simply not be running yet, and the
        // fallback chain covers it at run time.
        const proceed = window.confirm(
          `${provider.schema.label} is not reachable:\n\n${validation.message}\n\nSave anyway?`,
        );
        if (!proceed) {
          setBusy(undefined);
          return;
        }
      }

      await rpc('providers:save', {
        providerId: provider.schema.id,
        draft,
      } satisfies SaveParams);
      setStatus('Saved.');
      onSaved();
      onClose();
    } catch (cause) {
      setStatus((cause as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Panel title={provider.schema.label} onClose={onClose} onBack={onBack}>
      {provider.schema.docsUrl && (
        <p className="panel-hint">
          <a href={provider.schema.docsUrl}>Where to get a key ↗</a>
        </p>
      )}

      {fields.map((field) => (
        <Field
          key={field.id}
          field={field}
          value={draft[field.id]}
          hasStoredSecret={provider.storedSecrets[field.id] ?? false}
          models={field.kind === 'model' ? models : []}
          modelsError={field.kind === 'model' ? modelsError : undefined}
          busy={busy === 'models'}
          onLoadModels={loadModels}
          onChange={(value) => setDraft((current) => ({ ...current, [field.id]: value }))}
        />
      ))}

      <div className="panel-actions">
        <button type="button" className="btn btn-primary" disabled={!!busy} onClick={save}>
          {busy === 'saving' ? 'Checking…' : 'Save'}
        </button>
        <button type="button" className="btn" onClick={onBack}>
          Cancel
        </button>
      </div>

      {status && <p className="panel-hint">{status}</p>}
    </Panel>
  );
}

function Field({
  field,
  value,
  hasStoredSecret,
  models,
  modelsError,
  busy,
  onLoadModels,
  onChange,
}: {
  field: WireProviderField;
  value: string | number | undefined;
  hasStoredSecret: boolean;
  models: ProviderOption[];
  modelsError?: string;
  busy: boolean;
  onLoadModels(): void;
  onChange(value: string): void;
}) {
  const warning = typeof value === 'string' ? validateFieldFormat(field, value) : undefined;

  if (field.kind === 'model') {
    return (
      <label className="field">
        <span className="field-label">
          {field.label}
          {field.required && <span className="field-required">*</span>}
        </span>

        <div className="field-row">
          <input
            className="field-input"
            list={`models-${field.id}`}
            value={value === undefined ? '' : String(value)}
            placeholder={field.default === undefined ? undefined : String(field.default)}
            onChange={(event) => onChange(event.target.value)}
          />
          <button type="button" className="btn btn-small" disabled={busy} onClick={onLoadModels}>
            {busy ? '…' : 'List'}
          </button>
        </div>

        {/* A datalist keeps free entry available for a model not yet pulled or released. */}
        <datalist id={`models-${field.id}`}>
          {models.map((model) => (
            <option key={model.value} value={model.value}>
              {model.detail ?? model.label}
            </option>
          ))}
        </datalist>

        {field.description && <span className="field-hint">{field.description}</span>}
        {modelsError && <span className="field-warning">{modelsError}</span>}
      </label>
    );
  }

  if (field.kind === 'enum') {
    return (
      <label className="field">
        <span className="field-label">{field.label}</span>
        <select
          className="field-input"
          value={value === undefined ? (field.default ?? '') : String(value)}
          onChange={(event) => onChange(event.target.value)}
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {field.description && <span className="field-hint">{field.description}</span>}
      </label>
    );
  }

  const isSecret = field.kind === 'secret';

  return (
    <label className="field">
      <span className="field-label">
        {field.label}
        {field.required && <span className="field-required">*</span>}
      </span>
      <input
        className="field-input"
        type={isSecret ? 'password' : field.kind === 'number' ? 'number' : 'text'}
        value={value === undefined ? '' : String(value)}
        placeholder={
          isSecret && hasStoredSecret
            ? 'A key is stored — leave blank to keep it'
            : (field.placeholder ?? (field.kind !== 'secret' && field.default !== undefined ? String(field.default) : undefined))
        }
        onChange={(event) => onChange(event.target.value)}
      />
      {field.description && <span className="field-hint">{field.description}</span>}
      {warning && <span className="field-warning">{warning}</span>}
    </label>
  );
}

function Panel({
  title,
  onClose,
  onBack,
  children,
}: {
  title: string;
  onClose(): void;
  onBack?(): void;
  children: React.ReactNode;
}) {
  return (
    <div className="panel">
      <header className="panel-header">
        {onBack && (
          <button type="button" className="btn btn-small" onClick={onBack}>
            ←
          </button>
        )}
        <h2 className="panel-title">{title}</h2>
        <button type="button" className="btn btn-small" onClick={onClose} title="Close">
          ✕
        </button>
      </header>
      <div className="panel-body">{children}</div>
    </div>
  );
}
