import test from 'node:test';
import assert from 'node:assert/strict';
import { readText } from './helpers/loadJson';

test('preload exposes only specific safe IPC APIs and not the raw ipcRenderer', () => {
  const preload = readText('src/main/preload.ts');

  for (const channel of [
    'app:update-settings',
    'app:open-report-issue',
    'app:open-external',
    'app:move-overlay-by',
    'timer:visual-tick'
  ]) {
    assert.match(preload, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(preload, /contextBridge\.exposeInMainWorld\('poe2Overlay', api\)/);
  assert.doesNotMatch(preload, /exposeInMainWorld\([^)]*ipcRenderer/);
});

test('main process keeps renderer windows isolated and guards shell.openExternal', () => {
  const main = readText('src/main/main.ts');

  assert.match(main, /function isSafeExternalUrl/);
  assert.match(main, /ipcMain\.handle\('app:open-external'/);
  assert.match(main, /if \(!isSafeExternalUrl\(url\)\)/);
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.doesNotMatch(main, /\bremote\b/);
  assert.doesNotMatch(main, /\beval\s*\(/);
  assert.doesNotMatch(main, /\bnew Function\b/);
});
