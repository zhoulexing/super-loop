import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

// ───────────────────────────── 图标 ─────────────────────────────

const PATHS = {
  bot: '<rect x="4" y="8" width="16" height="11" rx="2"/><path d="M12 8V4M9 13h.01M15 13h.01"/>',
  msg: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/>',
  clip: '<path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"/>',
  tok: '<circle cx="12" cy="12" r="8"/><path d="M12 8v8M9.5 10h4a1.5 1.5 0 0 1 0 3h-3a1.5 1.5 0 0 0 0 3h4"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  retry:
    '<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5"/>',
  tool: '<path d="M14.7 6.3a4 4 0 0 0-5.3 5.3L4 17l3 3 5.4-5.4a4 4 0 0 0 5.3-5.3l-2.5 2.5-2.3-.5-.5-2.3Z"/>',
  src: '<path d="M4 4h16v12H8l-4 4Z"/>',
  dots: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  check: '<path d="m5 12 4.5 4.5L19 7"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
  queue: '<path d="M4 6h16M4 12h10M4 18h6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = 'icon' }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: PATHS[name] }}
    />
  );
}

// ───────────────────────────── 全局浮层 ─────────────────────────────

interface PopState {
  x: number;
  y: number;
  content: ReactNode;
}

interface UiApi {
  toast(text: string): void;
  openPop(x: number, y: number, content: ReactNode): void;
  closePop(): void;
  openModal(content: ReactNode): void;
  closeModal(): void;
  readonly hasOverlay: boolean;
}

const UiContext = createContext<UiApi | null>(null);

export function useUi(): UiApi {
  const ui = useContext(UiContext);
  if (!ui) throw new Error('useUi must be used inside <UiProvider>');
  return ui;
}

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Array<{ id: number; text: string }>>([]);
  const [pop, setPop] = useState<PopState | null>(null);
  const [modal, setModal] = useState<ReactNode>(null);
  const seq = useRef(0);

  const toast = useCallback((text: string) => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);

  const api = useMemo<UiApi>(
    () => ({
      toast,
      openPop: (x, y, content) => setPop({ x, y, content }),
      closePop: () => setPop(null),
      openModal: (content) => {
        setPop(null);
        setModal(content);
      },
      closeModal: () => setModal(null),
      hasOverlay: pop !== null || modal !== null,
    }),
    [toast, pop, modal],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (pop) {
        e.stopPropagation();
        setPop(null);
      } else if (modal) {
        e.stopPropagation();
        setModal(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pop, modal]);

  return (
    <UiContext.Provider value={api}>
      {children}
      {pop && <Popover state={pop} onClose={() => setPop(null)} />}
      {modal && (
        // biome-ignore lint/a11y/noStaticElementInteractions: 点击遮罩关闭弹窗，Esc 同样可关闭
        <div
          className="scrim"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setModal(null);
          }}
        >
          <div className="modal" role="dialog" aria-modal="true">
            {modal}
          </div>
        </div>
      )}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.text}
          </div>
        ))}
      </div>
    </UiContext.Provider>
  );
}

function Popover({ state, onClose }: { state: PopState; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: state.x, top: state.y });

  // 贴着视口边缘时向内收
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.min(Math.max(16, state.x), window.innerWidth - r.width - 16),
      top: Math.min(Math.max(16, state.y), window.innerHeight - r.height - 16),
    });
    el.querySelector<HTMLElement>('textarea, button.opt, select')?.focus();
  }, [state.x, state.y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    // 推迟一帧，避免打开它的那次点击立即把它关掉
    const id = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  return (
    <div className="pop" ref={ref} style={pos}>
      {state.content}
    </div>
  );
}

/** 通用确认框。 */
export function Confirm(props: { title: string; text: string; okLabel: string; onOk(): void }) {
  const ui = useUi();
  return (
    <>
      <h3>{props.title}</h3>
      <p style={{ margin: 0, color: 'var(--fg-2)' }}>{props.text}</p>
      <div className="row">
        <button type="button" className="btn" onClick={ui.closeModal}>
          取消
        </button>
        <button
          type="button"
          className="btn primary"
          // biome-ignore lint/a11y/noAutofocus: 确认框打开后聚焦主按钮
          autoFocus
          onClick={() => {
            ui.closeModal();
            props.onOk();
          }}
        >
          {props.okLabel}
        </button>
      </div>
    </>
  );
}
