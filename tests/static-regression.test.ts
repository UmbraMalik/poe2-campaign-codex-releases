// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readText } from './test-utils';

test('main-process timer heartbeat exists and renderer exposes visual tick API', () => {
  const main = readText('src/main/main.ts');
  const preload = readText('src/main/preload.ts');
  const types = readText('src/shared/types.ts');

  assert.match(main, /TIMER_VISUAL_HEARTBEAT_MS\s*=\s*1000/);
  assert.match(main, /timer:visual-tick/);
  assert.match(main, /startTimerVisualHeartbeat/);
  assert.match(preload, /onTimerVisualTick/);
  assert.match(preload, /timer:visual-tick/);
  assert.match(types, /TimerVisualTickPayload/);
});

test('no forbidden performance hacks are reintroduced', () => {
  const source = [
    readText('src/main/main.ts'),
    readText('src/main/preload.ts'),
    readText('src/renderer/pages/OverlayPage.tsx')
  ].join('\n');

  assert.doesNotMatch(source, /powerSaveBlocker/);
  assert.doesNotMatch(source, /setPriority\s*\(/);
  assert.doesNotMatch(source, /\[Perf\].*(priority|power save)/i);
});

test('overlay supports full left-click drag with an icon-only lock toggle', () => {
  const overlay = readText('src/renderer/pages/OverlayPage.tsx');
  const drag = readText('src/shared/overlay-drag.ts');
  const preload = readText('src/main/preload.ts');
  const styles = readText('src/renderer/styles.css');
  const types = readText('src/shared/types.ts');
  const lock = readText('src/renderer/overlay-lock.ts');

  assert.match(overlay, /moveOverlayBy/);
  assert.match(overlay, /shouldStartOverlayDrag/);
  assert.match(overlay, /overlayMovementLockedRef\.current/);
  assert.match(preload, /moveOverlayBy/);
  assert.match(types, /moveOverlayBy/);
  assert.match(drag, /button !== 0/);
  assert.match(drag, /button/);
  assert.match(drag, /resize-grip/);
  assert.doesNotMatch(drag, /window-drag-strip/);
  assert.match(overlay, /window-drag-strip/);
  assert.doesNotMatch(overlay, /Зажми ЛКМ в любой свободной части оверлея/);
  assert.doesNotMatch(overlay, /Оверлей закреплён/);
  assert.match(overlay, /overlay-lock-icon-button/);
  assert.match(overlay, /getOverlayLockButtonIcon/);
  assert.match(overlay, /toggleOverlayMovementLock/);
  assert.match(overlay, /getResizeGripClassName/);
  assert.match(lock, /'🔓'/);
  assert.match(lock, /'🔒'/);
  assert.match(styles, /overlay-lock-icon-button/);
  assert.match(styles, /resize-grip\.is-disabled/);
  assert.doesNotMatch(overlay, /unlockDragGuardActiveRef/);
  assert.doesNotMatch(overlay, /getWindowDragStripClassName/);
});

test('main overlay no longer shows old F9/F10 hint text', () => {
  const overlay = readText('src/renderer/pages/OverlayPage.tsx');
  assert.doesNotMatch(overlay, /РџРѕРґСЂРѕР±РЅРѕСЃС‚Рё:\s*F9\s*В·\s*F10 СЃРІРµСЂРЅСѓС‚СЊ/);
  assert.doesNotMatch(overlay, /F10 СЃРІРµСЂРЅСѓС‚СЊ/);
});

test('unknown/no-guide zones keep act context available for act timer display', () => {
  const main = readText('src/main/main.ts');
  const overlay = readText('src/renderer/pages/OverlayPage.tsx');
  assert.match(main, /inferActHintFromInternalAreaId/);
  assert.match(main, /lastGameplayAct/);
  assert.match(overlay, /currentZone\.actHint/);
  assert.match(overlay, /lastGameplayAct/);
});
