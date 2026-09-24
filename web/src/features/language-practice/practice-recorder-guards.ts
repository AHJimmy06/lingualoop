export const MAX_RECORDING_MS = 20_000;
export const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
export const MIN_RECORDING_MS = 250;

export function isValidRecording(durationMs: number, size: number): boolean {
  return Number.isFinite(durationMs)
    && durationMs >= MIN_RECORDING_MS
    && durationMs <= MAX_RECORDING_MS
    && size > 0
    && size <= MAX_AUDIO_BYTES;
}

export function isInteractiveShortcutTarget(target: EventTarget | null): boolean {
  return typeof Element !== 'undefined' && target instanceof Element && Boolean(target.closest(
    'input, select, textarea, button, a, summary, [contenteditable], [role~="button"], [role~="link"], [role~="tab"], [role~="checkbox"], [role~="radio"], [role~="switch"], [role~="option"], [role~="menuitem"], [role~="slider"], [role~="spinbutton"], [role~="textbox"], [role~="combobox"], [role~="listbox"], [role~="treeitem"], [role~="gridcell"], [role~="row"]',
  ));
}

export function isRecorderShortcut(event: KeyboardEvent, disabled: boolean): boolean {
  return !disabled
    && event.code === 'Space'
    && !event.repeat
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.shiftKey
    && !event.defaultPrevented
    && !isInteractiveShortcutTarget(event.target)
    && !(typeof document !== 'undefined' && isInteractiveShortcutTarget(document.activeElement));
}

export function formatRecordingTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `0:${String(seconds).padStart(2, '0')}`;
}
