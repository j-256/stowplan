"use client";

import {
  Columns2,
  Rows2,
} from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

export type PanelLayout = "side-by-side" | "stacked";

const DEFAULT_PANEL_PERCENT = 38;
const MIN_PANEL_PERCENT = 28;
const MAX_PANEL_PERCENT = 62;
const PANEL_KEYBOARD_STEP = 4;
const MIN_SIDE_BY_SIDE_WIDTH = 800;
const PANEL_LAYOUT_STORAGE_PREFIX = "stowplan-panel-layout";
const PANEL_SIZE_STORAGE_PREFIX = "stowplan-panel-size";

function clampPanelPercent(value: number): number {
  return Math.min(MAX_PANEL_PERCENT, Math.max(MIN_PANEL_PERCENT, value));
}

export function ResizablePanels({
  className,
  defaultPanelPercent = DEFAULT_PANEL_PERCENT,
  label,
  primary,
  primaryLabel,
  secondary,
  storageId,
}: {
  className: string;
  defaultPanelPercent?: number;
  label: string;
  primary: ReactNode;
  primaryLabel: string;
  secondary: ReactNode;
  storageId: string;
}) {
  const [canShowSideBySide, setCanShowSideBySide] = useState(true);
  const [layout, setLayout] = useState<PanelLayout>("side-by-side");
  const [panelPercent, setPanelPercent] = useState(
    clampPanelPercent(defaultPanelPercent),
  );
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [resizing, setResizing] = useState(false);
  const container = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- hydrate device-only panel preferences after the server-consistent first render */
    const savedLayout = localStorage.getItem(
      `${PANEL_LAYOUT_STORAGE_PREFIX}-${storageId}`,
    );
    if (savedLayout === "side-by-side" || savedLayout === "stacked") {
      setLayout(savedLayout);
    }
    const savedSize = Number(localStorage.getItem(
      `${PANEL_SIZE_STORAGE_PREFIX}-${storageId}`,
    ));
    if (Number.isFinite(savedSize) && savedSize > 0) {
      setPanelPercent(clampPanelPercent(savedSize));
    }
    setPreferencesReady(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [storageId]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const update = () => {
      setCanShowSideBySide(element.clientWidth >= MIN_SIDE_BY_SIDE_WIDTH);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!preferencesReady) return;
    localStorage.setItem(
      `${PANEL_LAYOUT_STORAGE_PREFIX}-${storageId}`,
      layout,
    );
    localStorage.setItem(
      `${PANEL_SIZE_STORAGE_PREFIX}-${storageId}`,
      String(panelPercent),
    );
  }, [layout, panelPercent, preferencesReady, storageId]);

  const effectiveLayout = canShowSideBySide ? layout : "stacked";
  const resizeTo = (clientX: number) => {
    const bounds = container.current?.getBoundingClientRect();
    if (!bounds?.width) return;
    setPanelPercent(clampPanelPercent(
      (clientX - bounds.left) / bounds.width * 100,
    ));
  };
  const changePanelPercent = (value: number) => {
    setPanelPercent(clampPanelPercent(value));
  };
  const style = {
    "--primary-pane": String(panelPercent / 100),
  } as CSSProperties;

  return <div
    className={`${className} resizable-panels`}
    data-panel-layout={effectiveLayout}
    data-panel-preference={layout}
    ref={container}
    style={style}
  >
    <div className="panel-layout-toolbar">
      <span>{label}</span>
      <div role="group" aria-label={`${label} layout`}>
        <button
          type="button"
          aria-pressed={effectiveLayout === "side-by-side"}
          data-active={effectiveLayout === "side-by-side"}
          disabled={!canShowSideBySide}
          title={canShowSideBySide ? "Show panels side by side" : "More width is needed for side-by-side panels"}
          onClick={() => setLayout("side-by-side")}
        >
          <Columns2 />
          <span>Side by side</span>
        </button>
        <button
          type="button"
          aria-pressed={effectiveLayout === "stacked"}
          data-active={effectiveLayout === "stacked"}
          onClick={() => setLayout("stacked")}
        >
          <Rows2 />
          <span>Stacked</span>
        </button>
      </div>
    </div>
    {primary}
    <div
      className="pane-resizer"
      data-resizing={resizing}
      role="separator"
      aria-label={`Resize ${primaryLabel}`}
      aria-orientation="vertical"
      aria-valuemax={MAX_PANEL_PERCENT}
      aria-valuemin={MIN_PANEL_PERCENT}
      aria-valuenow={Math.round(panelPercent)}
      tabIndex={effectiveLayout === "side-by-side" ? 0 : -1}
      onDoubleClick={() => changePanelPercent(defaultPanelPercent)}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          changePanelPercent(panelPercent - PANEL_KEYBOARD_STEP);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          changePanelPercent(panelPercent + PANEL_KEYBOARD_STEP);
        } else if (event.key === "Home") {
          event.preventDefault();
          changePanelPercent(MIN_PANEL_PERCENT);
        } else if (event.key === "End") {
          event.preventDefault();
          changePanelPercent(MAX_PANEL_PERCENT);
        }
      }}
      onPointerDown={(event) => {
        if (effectiveLayout !== "side-by-side") return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setResizing(true);
        resizeTo(event.clientX);
      }}
      onPointerMove={(event) => {
        if (resizing) resizeTo(event.clientX);
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        setResizing(false);
      }}
      onPointerCancel={() => setResizing(false)}
    >
      <span aria-hidden />
    </div>
    {secondary}
  </div>;
}
