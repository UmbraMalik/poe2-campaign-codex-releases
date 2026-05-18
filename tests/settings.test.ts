import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DEFAULT_CONFIG, DEFAULT_HOTKEYS } from '../src/shared/defaults';
import { ConfigStore, normalizeAppConfig } from '../src/main/services/config-store';
import { readText } from './helpers/loadJson';

test('normalizeAppConfig keeps defaults, custom settings and strips legacy unknown fields', () => {
  const normalized = normalizeAppConfig({
    logFilePath: 'C:\\temp\\LatestClient.txt',
    overlayOpacity: 0.5,
    overlayScale: 120,
    overlayDensity: 'compact',
    overlayMovementLocked: true,
    hotkeys: {
      openCompanion: 'Ctrl+F9'
    },
    oldSupportBlock: true
  } as never);

  assert.equal(normalized.logFilePath, 'C:\\temp\\LatestClient.txt');
  assert.equal(normalized.overlayOpacity, 0.5);
  assert.equal(normalized.overlayScale, 120);
  assert.equal(normalized.overlayDensity, 'compact');
  assert.equal(normalized.overlayMovementLocked, true);
  assert.equal(normalized.hotkeys.openCompanion, 'Ctrl+F9');
  assert.equal(normalized.hotkeys.toggleOverlayMode, DEFAULT_HOTKEYS.toggleOverlayMode);
  assert.equal('oldSupportBlock' in (normalized as unknown as Record<string, unknown>), false);
});

test('ConfigStore persists log path and merges settings safely', () => {
  const configPath = join(
    process.cwd(),
    '.tmp-tests',
    `settings-config-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
  );

  const store = new ConfigStore(configPath);
  const loaded = store.load();
  assert.equal(loaded.logFilePath, DEFAULT_CONFIG.logFilePath);

  store.update({
    logFilePath: 'Z:\\invalid\\LatestClient.txt',
    logFileSelectionMode: 'manual'
  });
  store.updateSettings({
    overlayOpacity: 0.77,
    overlayScale: 110,
    overlayMovementLocked: true,
    hotkeys: {
      openCompanion: 'Ctrl+F9'
    }
  });

  const reloaded = new ConfigStore(configPath).load();
  assert.equal(reloaded.logFilePath, 'Z:\\invalid\\LatestClient.txt');
  assert.equal(reloaded.logFileSelectionMode, 'manual');
  assert.equal(reloaded.overlayOpacity, 0.77);
  assert.equal(reloaded.overlayScale, 110);
  assert.equal(reloaded.overlayMovementLocked, true);
  assert.equal(reloaded.hotkeys.openCompanion, 'Ctrl+F9');
  assert.equal(reloaded.hotkeys.toggleOverlayMode, DEFAULT_HOTKEYS.toggleOverlayMode);
});

test('settings page keeps hotkey settings but no longer embeds reload-guide or support-link UI blocks', () => {
  const settingsPage = readText('src/renderer/pages/SettingsPage.tsx');

  assert.match(settingsPage, /toggleOverlayMode/);
  assert.match(settingsPage, /openCompanion/);
  assert.doesNotMatch(settingsPage, /Открепить|Закрепить/);
  assert.doesNotMatch(settingsPage, /reloadGuide\s*\(/);
  assert.doesNotMatch(settingsPage, /guide\.json/i);
  assert.doesNotMatch(settingsPage, /support-qr/i);
  assert.doesNotMatch(settingsPage, /https:\/\/t\.me\/POE2CampaignCodex/i);
  assert.doesNotMatch(settingsPage, /https:\/\/umbramalik\.github\.io\/poe2-campaign-codex\//i);
});

test('support and community stay separate windows instead of a settings-only block', () => {
  const mainSource = readText('src/main/main.ts');

  assert.match(mainSource, /app:open-community/);
  assert.match(mainSource, /app:open-support/);
  assert.match(mainSource, /openCommunityWindow/);
  assert.match(mainSource, /openSupportWindow/);
});

test('settings defaults keep safe overlay bounds and hotkeys visible in user settings', () => {
  assert.equal(DEFAULT_CONFIG.overlayOpacity >= 0.35, true);
  assert.equal(DEFAULT_CONFIG.overlayOpacity <= 1, true);
  assert.deepEqual(DEFAULT_CONFIG.hotkeys, DEFAULT_HOTKEYS);

  const settingsPage = readText('src/renderer/pages/SettingsPage.tsx');
  assert.match(settingsPage, /min=\{35\}/);
  assert.match(settingsPage, /max=\{100\}/);
  for (const scale of [70, 80, 90, 100, 110, 120]) {
    assert.match(settingsPage, new RegExp(`<option value=\\{${scale}\\}>${scale}%<\\/option>`));
  }
});
