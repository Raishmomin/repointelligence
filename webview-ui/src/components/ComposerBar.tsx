import { useEffect, useRef, useState } from 'react';
import type { ModelOptionDto, ModelStateDto, TaskModeDto } from '@shared/webview.types';

const MODES: Array<{ value: TaskModeDto; label: string; detail: string }> = [
  { value: 'implement', label: 'Implement', detail: 'Make the change, for your approval' },
  { value: 'plan', label: 'Plan', detail: 'Investigate and propose an approach' },
  { value: 'explain', label: 'Explain', detail: 'Answer questions, change nothing' },
];

interface Props {
  state: ModelStateDto;
  models: ModelOptionDto[];
  onSelectModel(providerId: string, modelId: string): void;
  onSetMode(mode: TaskModeDto): void;
  onAddProvider(): void;
  onRefreshModels(): void;
}

/**
 * The bar above the input: which model, which mode, and a way to add a provider.
 *
 * Both controls are the *current* value rendered as a button, so what is in effect is
 * always visible rather than being something you have to open a menu to discover.
 */
export function ComposerBar({
  state,
  models,
  onSelectModel,
  onSetMode,
  onAddProvider,
  onRefreshModels,
}: Props) {
  const [openMenu, setOpenMenu] = useState<'model' | 'mode' | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on an outside click or Escape — a popover that traps focus in a narrow sidebar
  // is worse than no popover.
  useEffect(() => {
    if (!openMenu) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMenu(null);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openMenu]);

  const activeMode = MODES.find((mode) => mode.value === state.mode) ?? MODES[0];
  const modelLabel = state.activeModelId || state.activeProviderLabel;

  const grouped = groupByProvider(models);

  return (
    <div className="composer-bar" ref={rootRef}>
      <button
        type="button"
        className={`chip ${state.fallbackFrom ? 'chip-warning' : ''}`}
        title={
          state.fallbackFrom
            ? `${state.fallbackFrom} was unavailable — running on ${state.activeProviderLabel}`
            : `${state.activeProviderLabel} · click to change model`
        }
        onClick={() => {
          setOpenMenu(openMenu === 'model' ? null : 'model');
          if (openMenu !== 'model') onRefreshModels();
        }}
      >
        <span className="codicon">{state.fallbackFrom ? '⚠' : '◆'}</span>
        <span className="chip-label">{modelLabel}</span>
        <span className="chip-caret">▾</span>
      </button>

      <button
        type="button"
        className="chip"
        title={activeMode.detail}
        onClick={() => setOpenMenu(openMenu === 'mode' ? null : 'mode')}
      >
        <span className="chip-label">{activeMode.label}</span>
        <span className="chip-caret">▾</span>
      </button>

      <div className="composer-bar-spacer" />

      <button type="button" className="chip chip-icon" title="Add a model provider" onClick={onAddProvider}>
        ＋
      </button>

      {openMenu === 'model' && (
        <div className="menu" role="listbox">
          {grouped.length === 0 && <div className="menu-empty">No providers configured yet.</div>}
          {grouped.map(([providerId, entries]) => (
            <div key={providerId} className="menu-group">
              <div className="menu-group-label">
                {entries[0].icon && <span className="codicon">◇</span>}
                {entries[0].providerLabel}
                {!entries[0].available && <span className="menu-badge">needs setup</span>}
              </div>
              {entries.map((model) => (
                <button
                  key={`${model.providerId}:${model.modelId}`}
                  type="button"
                  role="option"
                  aria-selected={isActive(state, model)}
                  className={`menu-item ${isActive(state, model) ? 'menu-item-active' : ''}`}
                  onClick={() => {
                    setOpenMenu(null);
                    // An empty modelId is the "set me up" row: selecting it opens the
                    // provider form rather than trying to switch to a model that has none.
                    if (!model.modelId) onAddProvider();
                    else onSelectModel(model.providerId, model.modelId);
                  }}
                >
                  <span className="menu-item-label">{model.label}</span>
                  {model.detail && <span className="menu-item-detail">{model.detail}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      {openMenu === 'mode' && (
        <div className="menu" role="listbox">
          {MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              role="option"
              aria-selected={mode.value === state.mode}
              className={`menu-item ${mode.value === state.mode ? 'menu-item-active' : ''}`}
              onClick={() => {
                setOpenMenu(null);
                onSetMode(mode.value);
              }}
            >
              <span className="menu-item-label">{mode.label}</span>
              <span className="menu-item-detail">{mode.detail}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function isActive(state: ModelStateDto, model: ModelOptionDto): boolean {
  return state.activeProviderId === model.providerId && state.activeModelId === model.modelId;
}

/** Preserves the order the host sent, which already ranks providers sensibly. */
function groupByProvider(models: ModelOptionDto[]): Array<[string, ModelOptionDto[]]> {
  const groups = new Map<string, ModelOptionDto[]>();
  for (const model of models) {
    const existing = groups.get(model.providerId);
    if (existing) existing.push(model);
    else groups.set(model.providerId, [model]);
  }
  return [...groups.entries()];
}
