import { useEffect, useRef, useState } from 'react';
import type { ApprovalModeDto, ModelOptionDto, ModelStateDto, TaskModeDto } from '@shared/webview.types';

const MODES: Array<{ value: TaskModeDto; label: string; detail: string }> = [
  { value: 'implement', label: 'Implement', detail: 'Make the change, for your approval' },
  { value: 'plan', label: 'Plan', detail: 'Investigate and propose an approach' },
  { value: 'explain', label: 'Explain', detail: 'Answer questions, change nothing' },
];

const APPROVAL_MODES: Array<{ value: ApprovalModeDto; label: string; icon: string; detail: string }> = [
  { value: 'ask', label: 'Ask', icon: '🛡', detail: 'Review & approve each change' },
  { value: 'auto', label: 'Auto', icon: '⚡', detail: 'Auto-approve safe file edits' },
  { value: 'yolo', label: 'Don\'t Ask', icon: '🔥', detail: 'Auto-approve all changes & commands' },
];

interface Props {
  state: ModelStateDto;
  models: ModelOptionDto[];
  onSelectModel(providerId: string, modelId: string): void;
  onSetMode(mode: TaskModeDto): void;
  onSetApprovalMode?(mode: ApprovalModeDto): void;
  onAddProvider(): void;
  onRefreshModels(): void;
}

/**
 * The bar above the input: which model, which mode, approval preference, and a way to add a provider.
 */
export function ComposerBar({
  state,
  models,
  onSelectModel,
  onSetMode,
  onSetApprovalMode,
  onAddProvider,
  onRefreshModels,
}: Props) {
  const [openMenu, setOpenMenu] = useState<'model' | 'mode' | 'approval' | null>(null);
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
  const activeApproval = APPROVAL_MODES.find((app) => app.value === state.approvalMode) ?? APPROVAL_MODES[0];
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

      <button
        type="button"
        className="chip"
        title={activeApproval.detail}
        onClick={() => setOpenMenu(openMenu === 'approval' ? null : 'approval')}
      >
        <span className="chip-icon-inline">{activeApproval.icon}</span>
        <span className="chip-label">{activeApproval.label}</span>
        <span className="chip-caret">▾</span>
      </button>

      <div className="composer-bar-spacer" />

      <button type="button" className="chip chip-icon" title="Add a model provider" onClick={onAddProvider}>
        ＋
      </button>

      {openMenu === 'model' && (
        <div className="menu" role="listbox">
          {grouped.length === 0 && <div className="menu-empty">No providers set up yet — use ＋ to add one.</div>}
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
                  <span className="menu-item-label">
                    {model.label}
                    {model.caution && (
                      <span className="menu-caution" title={model.detail}>
                        ⚠
                      </span>
                    )}
                  </span>
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

      {openMenu === 'approval' && (
        <div className="menu" role="listbox">
          {APPROVAL_MODES.map((app) => (
            <button
              key={app.value}
              type="button"
              role="option"
              aria-selected={app.value === (state.approvalMode ?? 'ask')}
              className={`menu-item ${app.value === (state.approvalMode ?? 'ask') ? 'menu-item-active' : ''}`}
              onClick={() => {
                setOpenMenu(null);
                if (onSetApprovalMode) onSetApprovalMode(app.value);
              }}
            >
              <span className="menu-item-label">
                <span className="chip-icon-inline">{app.icon}</span> {app.label}
              </span>
              <span className="menu-item-detail">{app.detail}</span>
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
