// @ts-nocheck
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = require("node:fs/promises");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const electron_1 = require("electron");
const config_store_1 = require("./services/config-store");
const guide_service_1 = require("./services/guide-service");
const log_parser_1 = require("./services/log-parser");
const log_watcher_1 = require("./services/log-watcher");
const runtime_paths_1 = require("./services/runtime-paths");
const update_service_1 = require("./services/update-service");
const auto_update_service_1 = require("./services/auto-update-service");
const defaults_1 = require("../shared/defaults");
const checklist_1 = require("../shared/checklist");
const timers_1 = require("../shared/timers");
const overlay_layout_1 = require("../shared/overlay-layout");
const translations_1 = require("../i18n/translations");
const town_scenes_json_1 = __importDefault(require("../data/town-scenes.json"));
const campaign_bonuses_json_1 = __importDefault(require("../data/campaign-bonuses.json"));
const forceProductionRenderer = process.env.ELECTRON_RENDERER_MODE === 'production' ||
    process.env.NODE_ENV === 'production';
const isDev = !electron_1.app.isPackaged && !forceProductionRenderer;
const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';
const DEV_SAMPLE_ZONE_LINE = '2026/05/12 12:00:00 Вы вошли в область: Грельвуд';
const DEFAULT_LOG_STATUS_MESSAGE = 'Ожидание лог-файла';
const BROADCAST_THROTTLE_MS = 100;
const UPDATE_CHECK_DELAY_MS = 4000;
const TIMER_VISUAL_HEARTBEAT_MS = 1000;
const TOWN_ZONE_HINTS = ['encampment', 'camp', 'town', 'hideout', 'лагерь', 'город', 'убежище'];
const SCENE_SOURCE_RE = /\[SCENE\]\s+Set Source\s+\[(.+?)\]/i;
const NON_GAMEPLAY_SCENES = new Set([
    '(null)',
    '(unknown)',
    'null',
    'unknown',
    'акт 1',
    'акт 2',
    'акт 3',
    'акт 4',
    'акт 5',
    'логин',
    'login',
    'меню',
    'menu'
]);
const LOGIN_SCENE_HINTS = [
    'логин',
    'login',
    'меню',
    'menu',
    'character select',
    'character selection',
    'select character',
    'screen login',
    'login screen'
];
const PENDING_AREA_ID_HOLD_SCENES = new Set([
    '(null)',
    '(unknown)',
    'null',
    'unknown',
    'act 1',
    'act 2',
    'act 3',
    'act 4',
    'act 5',
    '\u0430\u043a\u0442 1',
    '\u0430\u043a\u0442 2',
    '\u0430\u043a\u0442 3',
    '\u0430\u043a\u0442 4',
    '\u0430\u043a\u0442 5',
    'interlude',
    '\u0438\u043d\u0442\u0435\u0440\u043b\u044e\u0434\u0438\u044f'
]);
function normalizeSceneText(input) {
    return String(input ?? '')
        .toLowerCase()
        .replace(/\u0451/g, '\u0435')
        .trim();
}
export function inferActHintFromInternalAreaId(areaId) {
    const normalized = normalizeSceneText(areaId).replace(/^c_/, '');
    if (/^g1(?:_|$)/.test(normalized)) {
        return 1;
    }
    if (/^g2(?:_|$)/.test(normalized)) {
        return 2;
    }
    if (/^g3(?:_|$)/.test(normalized)) {
        return 3;
    }
    if (/^g4(?:_|$)/.test(normalized)) {
        return 4;
    }
    if (/^g5(?:_|$)/.test(normalized) || /^p[123](?:_|$)/.test(normalized)) {
        return 5;
    }
    return null;
}
const TOWN_SCENES = new Set((Array.isArray(town_scenes_json_1.default) ? town_scenes_json_1.default : [])
    .map((entry) => normalizeSceneText(String(entry ?? '')))
    .filter(Boolean));
electron_1.app.commandLine.appendSwitch('disable-renderer-backgrounding');
electron_1.app.commandLine.appendSwitch('disable-background-timer-throttling');
electron_1.app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
electron_1.app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling');
if (process.platform === 'linux') {
    const requestedOzonePlatform = String(process.env.POE2_OVERLAY_OZONE_PLATFORM ?? '').trim().toLowerCase();
    // Transparent Electron overlays are still compositor-sensitive on Linux.
    // Wayland sessions are forced through XWayland by default because the overlay relies on alpha.
    // Advanced users can opt back into native Wayland with POE2_OVERLAY_OZONE_PLATFORM=wayland.
    if (requestedOzonePlatform === 'x11' || requestedOzonePlatform === 'wayland') {
        electron_1.app.commandLine.appendSwitch('ozone-platform', requestedOzonePlatform);
    }
    else if (process.env.WAYLAND_DISPLAY) {
        electron_1.app.commandLine.appendSwitch('ozone-platform', 'x11');
    }
    electron_1.app.commandLine.appendSwitch('enable-transparent-visuals');
}
if (process.platform === 'win32') {
    electron_1.app.setAppUserModelId('com.codex.poe2-campaign-overlay');
}
const HOTKEY_ACTION_LABELS = {
    markChecklistDone: 'отметить текущий пункт',
    undoChecklistMark: 'отменить последнюю отметку',
    toggleTimerPause: 'пауза/продолжить таймер',
    openCompanion: 'подробная панель',
    toggleOverlayMode: 'режим оверлея'
};
function normalizeHotkeyAccelerator(value) {
    const raw = String(value ?? '').trim();
    if (!raw) {
        return null;
    }
    const parts = raw
        .replace(/\s+/g, '')
        .replace(/-/g, '+')
        .split('+')
        .filter(Boolean);
    if (parts.length === 0) {
        return null;
    }
    const modifiers = new Set();
    let key = null;
    for (const part of parts) {
        const upper = part.toUpperCase();
        if (upper === 'CTRL' || upper === 'CONTROL' || upper === 'CMDORCTRL' || upper === 'COMMANDORCONTROL') {
            modifiers.add('CommandOrControl');
            continue;
        }
        if (upper === 'SHIFT') {
            modifiers.add('Shift');
            continue;
        }
        if (upper === 'ALT' || upper === 'OPTION') {
            modifiers.add('Alt');
            continue;
        }
        if (upper === 'META' || upper === 'CMD' || upper === 'COMMAND' || upper === 'SUPER') {
            modifiers.add(process.platform === 'darwin' ? 'Command' : 'Super');
            continue;
        }
        if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(upper)) {
            key = upper;
            continue;
        }
        if (/^[A-Z]$/.test(upper) || /^\d$/.test(upper)) {
            key = upper;
            continue;
        }
        if (upper === 'SPACE') {
            key = 'Space';
            continue;
        }
        return null;
    }
    if (!key) {
        return null;
    }
    const isFunctionKey = /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key);
    // Do not allow bare letters/digits/space as global shortcuts — that would hijack normal typing.
    if (!isFunctionKey && modifiers.size === 0) {
        return null;
    }
    const orderedModifiers = ['CommandOrControl', 'Command', 'Super', 'Alt', 'Shift'].filter((modifier) => modifiers.has(modifier));
    return [...orderedModifiers, key].join('+');
}
function formatConfiguredHotkey(value, fallback) {
    return normalizeHotkeyAccelerator(value) ?? normalizeHotkeyAccelerator(fallback) ?? fallback;
}
function clampOpacity(value) {
    return Math.min(1, Math.max(0.35, value));
}
function isSafeExternalUrl(url) {
    if (typeof url !== 'string') {
        return false;
    }
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    }
    catch {
        return false;
    }
}
function createTrayIcon() {
    const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
      <rect width="32" height="32" rx="8" fill="#11161e"/>
      <path d="M9 8h14v3H12v4h9v3h-9v6H9z" fill="#ffd27a"/>
      <circle cx="23" cy="23" r="3" fill="#ff6c6c"/>
    </svg>
  `;
    return electron_1.nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}
function resolveAssetPath(...segments) {
    return (0, runtime_paths_1.resolveRuntimePath)(...segments);
}
function createAppIcon() {
    const iconPath = process.platform === 'win32'
        ? resolveAssetPath('assets', 'app-icon.ico')
        : resolveAssetPath('assets', 'app-icon.png');
    const icon = electron_1.nativeImage.createFromPath(iconPath);
    return icon.isEmpty() ? createTrayIcon() : icon;
}
export class PoeOverlayApp {
    constructor() {
        this.configStore = new config_store_1.ConfigStore((0, node_path_1.join)(electron_1.app.getPath('userData'), 'config.json'));
        this.guideService = new guide_service_1.GuideService();
        this.campaignBonuses = campaign_bonuses_json_1.default.bonuses;
        this.logWatcher = new log_watcher_1.LogWatcher(this.guideService, {
            onLine: (line, source) => {
                this.runtime.lastLogLineAt = new Date().toISOString();
                this.runtime.lastLogLine = line;
                this.processRunTimerActivityFromLogLine(line, source);
                this.processLevelUpFromLogLine(line, source);
                this.applyCampaignBonusMatchesFromLogLine(line, source);
                // Do not broadcast the full app snapshot for every log line. Zone changes,
                // level ups and reward callbacks broadcast only when they actually
                // change user-visible state. This keeps the overlay renderer from being
                // flooded while the game writes many log lines during combat/area loads.
            },
            onAppendLine: (line) => {
                this.runtime.lastAppendedLine = line;
            },
            onZoneDetected: (zoneMatch) => {
                this.runtime.lastMatcherReason = zoneMatch.matcherReason;
                this.runtime.lastMatchedAt = new Date().toISOString();
            },
            onStatusChange: (status, message) => {
                this.setLogStatus(status, message);
            },
            onRuntimeStateChange: (state) => {
                const shouldBroadcast = this.runtime.watchedLogPath !== state.watchedLogPath ||
                    this.runtime.logFileExists !== state.fileExists ||
                    this.runtime.watcherLastMatchedZone !== state.lastMatchedZone;
                this.runtime.watchedLogPath = state.watchedLogPath;
                this.runtime.currentLogOffset = state.currentOffset;
                this.runtime.logFileExists = state.fileExists;
                this.runtime.logFileSize = state.lastFileSize;
                this.runtime.lastAppendedLine = state.lastAppendedLine;
                this.runtime.watcherLastMatchedZone = state.lastMatchedZone;
                this.runtime.lastWatcherUpdateAt = state.lastUpdateTimestamp;
                this.runtime.lastReadAt = state.lastReadAt;
                this.runtime.lastMatchedAt = state.lastMatchedAt;
                this.runtime.lastMatcherReason = state.lastMatcherReason;
                if (shouldBroadcast) {
                    this.broadcastState();
                }
            }
        });
        this.overlayWindow = null;
        this.settingsWindow = null;
        this.companionWindow = null;
        this.infoWindow = null;
        this.communityWindow = null;
        this.supportWindow = null;
        this.reportWindow = null;
        this.closeConfirmWindow = null;
        this.updateWindow = null;
        this.tray = null;
        this.processedCampaignRewardLogLineKeys = new Set();
        this.processedCampaignRewardLogLineOrder = [];
        this.cachedUpdateCheckResult = null;
        this.startupUpdateInfo = null;
        this.autoUpdateService = new auto_update_service_1.AutoUpdateService();
        this.autoUpdateService.onStateChanged((state) => this.broadcastAutoUpdateState(state));
        this.config = this.configStore.load();
        this.overlayMode = 'full';
        this.currentZone = {
            rawZoneName: null,
            guide: null,
            sceneKind: 'unknown',
            actHint: null
        };
        this.pendingZoneAreaId = null;
        this.runtime = {
            timerNowMs: Date.now(),
            guideLoadedAt: null,
            lastLogLine: null,
            lastRawZoneName: null,
            lastMatchedZoneEn: null,
            lastMatchedZoneRu: null,
            lastMatchedGuideId: null,
            lastZoneSource: null,
            logWatcherStatus: 'idle',
            logWatcherMessage: DEFAULT_LOG_STATUS_MESSAGE,
            logFileExists: false,
            logFileSize: null,
            watchedLogPath: null,
            currentLogOffset: 0,
            lastAppendedLine: null,
            watcherLastMatchedZone: null,
            lastWatcherUpdateAt: null,
            lastReadAt: null,
            lastMatchedAt: null,
            lastMatcherReason: 'none',
            lastLevelUpDetectedAt: null,
            lastLogLineAt: null,
            lastValidGameplayZoneAt: null,
            lastGameplayGuideId: null,
            lastGameplayZoneRu: null,
            lastGameplayAct: null,
            lastSceneSource: null,
            lastSceneSourceAt: null,
            overlayMode: 'full',
            missedWarningZoneRu: null,
            missedWarningItems: []
        };
        this.isQuitting = false;
        this.isClosingOverlayWindow = false;
        this.isQuittingConfirmed = false;
        this.isQuitConfirmationInFlight = false;
        this.isOverlayCloseConfirmationInFlight = false;
        this.pendingCloseConfirmResult = null;
        this.resolveCloseConfirmResult = null;
        this.logInfoRefreshTimer = null;
        this.checklistHistory = [];
        this.broadcastTimer = null;
        this.pendingSnapshot = null;
        this.overlayBoundsTimer = null;
        this.companionBoundsTimer = null;
        this.runTimerStartTimer = null;
        this.timerVisualHeartbeat = null;
        this.updateCheckTimer = null;
        this.isAutoUpdateCheckInFlight = false;
        this.globalHotkeysRegistered = false;
        this.registeredGlobalHotkeys = new Set();
    }
    async bootstrap() {
        this.overlayMode = this.getStartupOverlayMode();
        this.runtime.overlayMode = this.overlayMode;
        this.loadGuide();
        this.restoreLastZoneFromConfig();
        this.reconcileRunTimerState();
        await this.ensureLogFile();
        this.registerGlobalHotkeys();
        this.createOverlayWindow();
        this.startTimerVisualHeartbeat();
        this.createTray();
        this.registerIpc();
        this.bindAppEvents();
        this.scheduleStartupUpdateCheck();
        if (!this.config.logFilePath) {
            this.openSettingsWindow();
        }
        else {
            await this.startLogWatcher(this.config.logFilePath, this.config.ignoreExistingLogOnNextStart);
        }
        this.broadcastState();
    }
    bindAppEvents() {
        electron_1.app.on('before-quit', (event) => {
            if (this.isQuittingConfirmed) {
                this.prepareForQuit();
                return;
            }
            if (this.isQuitConfirmationInFlight) {
                event.preventDefault();
                this.closeConfirmWindow?.show();
                this.closeConfirmWindow?.focus();
                return;
            }
            if (this.config.runTimer.status !== 'running') {
                this.isQuittingConfirmed = true;
                this.prepareForQuit();
                return;
            }
            event.preventDefault();
            void this.confirmQuitWhileRunTimerIsRunning();
        });
        electron_1.app.on('window-all-closed', () => {
            // Keep the tray app alive when the overlay window itself is closed.
            // Explicit app.quit() still works through the tray/menu and goes through before-quit above.
        });
    }
    prepareForQuit() {
        if (this.isQuitting) {
            return;
        }
        this.isQuitting = true;
        this.stopTimerVisualHeartbeat();
        if (this.closeConfirmWindow && !this.closeConfirmWindow.isDestroyed()) {
            this.closeConfirmWindow.destroy();
        }
        this.closeConfirmWindow = null;
        if (this.communityWindow && !this.communityWindow.isDestroyed()) {
            this.communityWindow.destroy();
        }
        this.communityWindow = null;
        if (this.supportWindow && !this.supportWindow.isDestroyed()) {
            this.supportWindow.destroy();
        }
        this.supportWindow = null;
        if (this.reportWindow && !this.reportWindow.isDestroyed()) {
            this.reportWindow.destroy();
        }
        this.reportWindow = null;
        if (this.updateWindow && !this.updateWindow.isDestroyed()) {
            this.updateWindow.destroy();
        }
        this.updateWindow = null;
        this.pendingCloseConfirmResult = null;
        this.resolveCloseConfirmResult = null;
        if (this.updateCheckTimer) {
            clearTimeout(this.updateCheckTimer);
            this.updateCheckTimer = null;
        }
        this.clearLogFileInfoRefreshTimer();
        this.clearBroadcastTimer();
        if (this.overlayBoundsTimer) {
            clearTimeout(this.overlayBoundsTimer);
            this.overlayBoundsTimer = null;
        }
        if (this.companionBoundsTimer) {
            clearTimeout(this.companionBoundsTimer);
            this.companionBoundsTimer = null;
        }
        this.clearRunTimerStartTimer();
        electron_1.globalShortcut.unregisterAll();
        this.registeredGlobalHotkeys.clear();
        this.globalHotkeysRegistered = false;
        this.logWatcher.stop();
    }
    getQuitDialogOwnerWindow() {
        const focusedWindow = electron_1.BrowserWindow.getFocusedWindow();
        if (focusedWindow && !focusedWindow.isDestroyed()) {
            return focusedWindow;
        }
        return [this.overlayWindow, this.settingsWindow, this.companionWindow, this.infoWindow, this.communityWindow, this.supportWindow, this.reportWindow].find((win) => Boolean(win && !win.isDestroyed() && win.isVisible()));
    }
    async showMessageBoxSafe(options) {
        const owner = this.getQuitDialogOwnerWindow();
        return owner ? electron_1.dialog.showMessageBox(owner, options) : electron_1.dialog.showMessageBox(options);
    }
    getCurrentLanguage() {
        return this.config?.appLanguage === 'en' ? 'en' : 'ru';
    }
    t(key, params) {
        return (0, translations_1.translate)(this.getCurrentLanguage(), key, params);
    }
    getUpdateWindowOwner() {
        const focusedWindow = electron_1.BrowserWindow.getFocusedWindow();
        if (focusedWindow &&
            !focusedWindow.isDestroyed() &&
            focusedWindow !== this.updateWindow) {
            return focusedWindow;
        }
        return [this.settingsWindow, this.companionWindow, this.infoWindow, this.communityWindow, this.supportWindow, this.reportWindow, this.overlayWindow].find((win) => Boolean(win && !win.isDestroyed() && win.isVisible()));
    }
    broadcastAutoUpdateState(state) {
        const windows = [
            this.settingsWindow,
            this.updateWindow,
            this.companionWindow,
            this.infoWindow,
            this.communityWindow,
            this.supportWindow,
            this.reportWindow,
            this.overlayWindow
        ];
        for (const window of windows) {
            if (window && !window.isDestroyed()) {
                window.webContents.send('app:auto-update-changed', state);
            }
        }
    }

    scheduleStartupUpdateCheck() {
        if (this.updateCheckTimer) {
            clearTimeout(this.updateCheckTimer);
        }
        this.updateCheckTimer = setTimeout(() => {
            this.updateCheckTimer = null;
            void this.runStartupUpdateCheck();
        }, UPDATE_CHECK_DELAY_MS);
    }
    async runStartupUpdateCheck() {
        if (this.isQuitting || this.isAutoUpdateCheckInFlight) {
            return;
        }
        this.isAutoUpdateCheckInFlight = true;
        try {
            const autoState = await this.autoUpdateService.checkForUpdates();
            if (autoState.status === 'available') {
                this.openUpdateWindow();
                return;
            }
            // Dev fallback: electron-updater usually cannot work without packaged update config.
            // Keep the existing GitHub Releases checker useful for local testing.
            if (autoState.status === 'error' && isDev) {
                const result = await this.checkForUpdates(false);
                if (result.status === 'available' && result.update) {
                    this.openUpdateWindow(result.update);
                }
            }
        }
        finally {
            this.isAutoUpdateCheckInFlight = false;
        }
    }
    async checkForUpdates(showErrors = true) {
        const result = await (0, update_service_1.checkForUpdates)(electron_1.app.getVersion());
        if (result.status === 'error') {
            if (showErrors) {
                this.cachedUpdateCheckResult = result;
            }
            return result;
        }
        this.cachedUpdateCheckResult = result;
        this.startupUpdateInfo = result.status === 'available' ? result.update ?? null : null;
        return result;
    }
    openUpdateWindow(updateInfo = null) {
        this.startupUpdateInfo = updateInfo;
        if (this.updateWindow && !this.updateWindow.isDestroyed()) {
            this.updateWindow.show();
            this.updateWindow.focus();
            return;
        }
        const parentWindow = this.getUpdateWindowOwner();
        this.updateWindow = new electron_1.BrowserWindow({
            icon: createAppIcon(),
            width: 680,
            height: 720,
            minWidth: 620,
            minHeight: 560,
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            show: false,
            frame: false,
            titleBarStyle: 'hidden',
            backgroundColor: '#101318',
            autoHideMenuBar: true,
            skipTaskbar: true,
            alwaysOnTop: true,
            ...(parentWindow ? { parent: parentWindow } : {}),
            webPreferences: {
                preload: (0, node_path_1.join)(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                backgroundThrottling: false
            }
        });
        this.updateWindow.setMenuBarVisibility(false);
        this.updateWindow.removeMenu();
        this.updateWindow.setAlwaysOnTop(true, 'screen-saver');
        this.updateWindow.on('closed', () => {
            this.updateWindow = null;
        });
        void this.loadWindowPage(this.updateWindow, 'update');
        this.updateWindow.once('ready-to-show', () => {
            this.updateWindow?.show();
            this.updateWindow?.focus();
        });
    }
    settleCloseConfirm(result) {
        const resolve = this.resolveCloseConfirmResult;
        const window = this.closeConfirmWindow;
        this.resolveCloseConfirmResult = null;
        this.pendingCloseConfirmResult = null;
        this.closeConfirmWindow = null;
        if (window && !window.isDestroyed()) {
            window.destroy();
        }
        resolve?.(result);
    }
    async showCustomQuitConfirmation() {
        if (this.pendingCloseConfirmResult) {
            this.closeConfirmWindow?.show();
            this.closeConfirmWindow?.focus();
            return this.pendingCloseConfirmResult;
        }
        try {
            const parentWindow = this.getQuitDialogOwnerWindow();
            const closeConfirmWindow = new electron_1.BrowserWindow({
                width: 500,
                height: 252,
                minWidth: 460,
                minHeight: 220,
                maxWidth: 520,
                maxHeight: 320,
                resizable: false,
                minimizable: false,
                maximizable: false,
                fullscreenable: false,
                movable: true,
                show: false,
                frame: false,
                transparent: false,
                backgroundColor: '#101318',
                title: this.t('main.quitTitle'),
                skipTaskbar: true,
                alwaysOnTop: true,
                modal: Boolean(parentWindow),
                ...(parentWindow ? { parent: parentWindow } : {}),
                webPreferences: {
                    preload: (0, node_path_1.join)(__dirname, 'preload.js'),
                    contextIsolation: true,
                    nodeIntegration: false,
                    backgroundThrottling: false
                }
            });
            closeConfirmWindow.setMenuBarVisibility(false);
            closeConfirmWindow.removeMenu();
            closeConfirmWindow.setAlwaysOnTop(true, 'screen-saver');
            closeConfirmWindow.on('close', (event) => {
                if (!this.resolveCloseConfirmResult) {
                    return;
                }
                event.preventDefault();
                this.settleCloseConfirm('stay');
            });
            closeConfirmWindow.on('closed', () => {
                this.closeConfirmWindow = null;
            });
            this.closeConfirmWindow = closeConfirmWindow;
            this.pendingCloseConfirmResult = new Promise((resolve) => {
                this.resolveCloseConfirmResult = resolve;
            });
            closeConfirmWindow.once('ready-to-show', () => {
                closeConfirmWindow.show();
                closeConfirmWindow.focus();
            });
            await this.loadWindowPage(closeConfirmWindow, 'close-confirm');
            return this.pendingCloseConfirmResult;
        }
        catch (error) {
            console.error('[Quit] Failed to open custom quit confirmation window.', error);
            if (this.closeConfirmWindow && !this.closeConfirmWindow.isDestroyed()) {
                this.closeConfirmWindow.destroy();
            }
            this.closeConfirmWindow = null;
            this.pendingCloseConfirmResult = null;
            this.resolveCloseConfirmResult = null;
            return null;
        }
    }
    async showNativeQuitConfirmation() {
        const result = await this.showMessageBoxSafe({
            type: 'warning',
            title: this.t('main.quitTitle'),
            message: this.t('main.quitMessage'),
            detail: this.t('main.quitDetail'),
            buttons: [this.t('main.stay'), this.t('main.closeAndSave')],
            defaultId: 0,
            cancelId: 0,
            noLink: true
        });
        return result.response === 1;
    }
    buildManualPausedRunTimer(now) {
        const runTimer = this.config.runTimer;
        return {
            ...runTimer,
            status: 'paused',
            elapsedMs: this.getRunTimerDisplayElapsedMs(now),
            resumedAt: null,
            pausedAt: now,
            lastZoneEnteredAt: null,
            currentZoneElapsedMs: this.getCurrentZoneElapsedMs(now),
            pauseReason: 'manual',
            pauseCount: runTimer.pauseCount + 1
        };
    }
    pauseRunTimerForQuit(now = Date.now()) {
        const runTimer = this.config.runTimer;
        if (runTimer.status !== 'running') {
            return;
        }
        this.persistRunTimer(this.buildManualPausedRunTimer(now));
        this.refreshTrayMenu();
        this.broadcastState();
    }
    async confirmQuitWhileRunTimerIsRunning() {
        if (this.isQuitConfirmationInFlight) {
            this.closeConfirmWindow?.show();
            this.closeConfirmWindow?.focus();
            return;
        }
        this.isQuitConfirmationInFlight = true;
        let shouldQuit = false;
        try {
            const customResult = await this.showCustomQuitConfirmation();
            if (customResult === 'close_and_save') {
                shouldQuit = true;
            }
            else if (customResult === null) {
                shouldQuit = await this.showNativeQuitConfirmation();
            }
            if (!shouldQuit) {
                return;
            }
            this.pauseRunTimerForQuit(Date.now());
        }
        catch (error) {
            console.error('[Quit] Failed to preserve running timer before exit.', error);
            await this.showMessageBoxSafe({
                type: 'error',
                title: this.t('main.saveTimerErrorTitle'),
                message: this.t('main.saveTimerErrorTitle'),
                detail: this.t('main.saveTimerErrorDetail'),
                buttons: [this.t('common.ok')],
                defaultId: 0,
                cancelId: 0,
                noLink: true
            });
        }
        finally {
            this.isQuitConfirmationInFlight = false;
        }
        if (!shouldQuit) {
            return;
        }
        this.isQuittingConfirmed = true;
        electron_1.app.quit();
    }
    async installAutoUpdate() {
        const state = this.autoUpdateService.getState();
        if (state.status !== 'downloaded') {
            return false;
        }
        try {
            if (this.config.runTimer.status === 'running') {
                this.pauseRunTimerForQuit(Date.now());
            }
            this.isQuittingConfirmed = true;
            this.prepareForQuit();
            setTimeout(() => {
                this.autoUpdateService.quitAndInstall();
            }, 50);
            return true;
        }
        catch (error) {
            console.error('[AutoUpdate] Failed to install update.', error);
            return false;
        }
    }

    registerIpc() {
        electron_1.ipcMain.handle('app:get-snapshot', async () => this.getSnapshot());
        electron_1.ipcMain.handle('app:get-version', async () => electron_1.app.getVersion());
        electron_1.ipcMain.handle('app:get-cached-update-check-result', async () => this.cachedUpdateCheckResult);
        electron_1.ipcMain.handle('app:get-startup-update-info', async () => this.startupUpdateInfo);
        electron_1.ipcMain.handle('app:check-for-updates', async () => this.checkForUpdates(true));
        electron_1.ipcMain.handle('app:auto-update-get-state', async () => this.autoUpdateService.getState());
        electron_1.ipcMain.handle('app:auto-update-check', async () => this.autoUpdateService.checkForUpdates());
        electron_1.ipcMain.handle('app:auto-update-download', async () => this.autoUpdateService.downloadUpdate());
        electron_1.ipcMain.handle('app:auto-update-install', async () => this.installAutoUpdate());
        electron_1.ipcMain.handle('timer:get-state', async () => this.config.runTimer);
        electron_1.ipcMain.handle('close-confirm:stay', async () => {
            this.settleCloseConfirm('stay');
            return true;
        });
        electron_1.ipcMain.handle('close-confirm:close-and-save', async () => {
            this.settleCloseConfirm('close_and_save');
            return true;
        });
        electron_1.ipcMain.handle('app:choose-log-file', async () => {
            const owner = this.settingsWindow ?? this.overlayWindow;
            const dialogOptions = {
                title: this.t('main.chooseLogFileTitle'),
                properties: ['openFile'],
                filters: [
                    { name: this.t('main.logFileFilter'), extensions: ['txt'] },
                    { name: this.t('main.allFilesFilter'), extensions: ['*'] }
                ]
            };
            const result = owner
                ? await electron_1.dialog.showOpenDialog(owner, dialogOptions)
                : await electron_1.dialog.showOpenDialog(dialogOptions);
            if (result.canceled || result.filePaths.length === 0) {
                return null;
            }
            const selectedPath = result.filePaths[0] ?? null;
            if (selectedPath) {
                this.config = this.configStore.update({
                    logFilePath: selectedPath,
                    logFileSelectionMode: 'manual'
                });
                await this.startLogWatcher(selectedPath);
                this.broadcastState();
            }
            return selectedPath;
        });
        electron_1.ipcMain.handle('app:update-settings', async (_event, patch) => {
            const previousOverlayMode = this.overlayMode;
            const previousOverlayDensity = this.config.overlayDensity;
            const previousOverlayScale = this.config.overlayScale;
            const nextOverlayMode = patch.mainOverlaySettings?.overlayMode ?? previousOverlayMode;
            const nextOverlayDensity = patch.overlayDensity ?? previousOverlayDensity;
            const nextOverlayScale = patch.overlayScale ?? previousOverlayScale;
            const overlayLayoutChanged = nextOverlayMode !== previousOverlayMode || nextOverlayDensity !== previousOverlayDensity;
            const overlayConstraintsChanged = overlayLayoutChanged || nextOverlayScale !== previousOverlayScale;
            const previousOverlayBounds = overlayConstraintsChanged && this.overlayWindow && !this.overlayWindow.isDestroyed()
                ? this.overlayWindow.getBounds()
                : null;
            if (overlayLayoutChanged && previousOverlayBounds) {
                if (this.overlayBoundsTimer) {
                    clearTimeout(this.overlayBoundsTimer);
                    this.overlayBoundsTimer = null;
                }
                this.persistOverlayBoundsForState(previousOverlayMode, previousOverlayDensity, previousOverlayBounds);
            }
            this.config = this.configStore.updateSettings({
                ...patch,
                ...(patch.overlayOpacity !== undefined
                    ? { overlayOpacity: clampOpacity(patch.overlayOpacity) }
                    : {})
            });
            if (patch.overlayOpacity !== undefined) {
                this.overlayWindow?.setOpacity(this.config.overlayOpacity);
            }
            if (patch.companionAlwaysOnTop !== undefined) {
                this.companionWindow?.setAlwaysOnTop(this.config.companionAlwaysOnTop);
            }
            if (patch.runTimerSettings !== undefined) {
                this.reconcileRunTimerState();
            }
            if (patch.hotkeys !== undefined || patch.manualHotkeysEnabled !== undefined) {
                this.registerGlobalHotkeys();
            }
            if (patch.mainOverlaySettings?.overlayMode) {
                this.overlayMode = patch.mainOverlaySettings.overlayMode;
                this.runtime.overlayMode = this.overlayMode;
            }
            if (overlayConstraintsChanged && this.overlayWindow && !this.overlayWindow.isDestroyed()) {
                const minimumSize = this.getOverlayMinimumSize(this.overlayMode, this.config.overlayDensity, this.config.overlayScale);
                const nextBounds = overlayLayoutChanged
                    ? this.getOverlayBoundsForMode(this.overlayMode, this.config.overlayDensity)
                    : this.normalizeOverlayBoundsForMode(previousOverlayBounds ?? this.overlayWindow.getBounds(), this.overlayMode, this.config.overlayDensity);
                this.overlayWindow.setMinimumSize(minimumSize.width, minimumSize.height);
                this.overlayWindow.setBounds(nextBounds);
            }
            this.refreshTrayMenu();
            this.broadcastState();
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:simulate-zone', async (_event, zoneSelector) => {
            const guide = this.guideService.findById(zoneSelector) ??
                this.guideService.findByZoneName(zoneSelector);
            if (guide) {
                this.setCurrentZone(guide.zone_ru, 'simulation', guide);
            }
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:reload-guide', async () => {
            this.loadGuide();
            this.rebindCurrentZoneAfterGuideReload();
            await this.logWatcher.seekToEnd();
            this.broadcastState();
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:reset-progress', async () => {
            this.clearRunTimerStartTimer();
            this.config = this.configStore.resetProgress();
            this.checklistHistory.length = 0;
            this.currentZone = {
                rawZoneName: null,
                guide: null,
                sceneKind: 'unknown',
                actHint: null
            };
            this.runtime.lastRawZoneName = null;
            this.runtime.lastMatchedZoneEn = null;
            this.runtime.lastMatchedZoneRu = null;
            this.runtime.lastMatchedGuideId = null;
            this.runtime.lastGameplayGuideId = null;
            this.runtime.lastGameplayZoneRu = null;
            this.runtime.lastGameplayAct = null;
            this.runtime.lastZoneSource = null;
            this.runtime.lastLevelUpDetectedAt = null;
            this.runtime.missedWarningZoneRu = null;
            this.runtime.missedWarningItems = [];
            this.broadcastState();
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:reset-level-reminders', async () => {
            this.config = this.configStore.update({
                levelRemindersState: {
                    shown: [],
                    dismissed: [],
                    activeLevelReminderId: null
                }
            });
            this.broadcastState();
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:set-campaign-bonus-done', async (_event, bonusId, done) => {
            this.setCampaignBonusDone(bonusId, done ? 'manual' : null);
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:reset-campaign-bonuses', async () => {
            this.config = this.configStore.update({
                campaignBonusProgress: {}
            });
            this.broadcastState();
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:dismiss-active-level-reminder', async () => {
            const state = this.config.levelRemindersState ?? {
                shown: [],
                dismissed: [],
                activeLevelReminderId: null
            };
            const activeId = state.activeLevelReminderId;
            this.config = this.configStore.update({
                levelRemindersState: {
                    shown: state.shown ?? [],
                    dismissed: activeId
                        ? Array.from(new Set([...(state.dismissed ?? []), activeId]))
                        : state.dismissed ?? [],
                    activeLevelReminderId: null
                }
            });
            this.broadcastState();
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:append-dev-log-line', async (_event, rawLine) => {
            const targetPath = this.config.logFilePath ?? this.runtime.watchedLogPath;
            if (!targetPath) {
                return this.getSnapshot();
            }
            const line = rawLine.trim() || DEV_SAMPLE_ZONE_LINE;
            const payload = line.endsWith('\n') ? line : `${line}\r\n`;
            await (0, promises_1.appendFile)(targetPath, payload, 'utf8');
            await this.refreshLogFileInfo(targetPath);
            await this.logWatcher.checkNow();
            this.broadcastState();
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:mark-current-checklist-item-done', async () => {
            this.markCurrentChecklistItemDone();
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:undo-last-checklist-mark', async () => {
            this.undoLastChecklistMark();
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:arm-run-timer', async () => {
            this.armRunTimer();
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:start-run-timer', async () => {
            this.startRunTimerNow();
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:pause-run-timer', async () => {
            this.pauseRunTimer();
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:resume-run-timer', async () => {
            this.resumeRunTimer();
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:reset-run-timer', async () => {
            this.resetRunTimer();
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:finish-run-timer', async () => {
            this.finishRunTimer();
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:resize-overlay', async (_event, width, height) => {
            const targetWindow = this.overlayWindow;
            if (!targetWindow || targetWindow.isDestroyed()) {
                return this.getSnapshot();
            }
            const currentBounds = targetWindow.getBounds();
            const nextBounds = this.normalizeOverlayBoundsForMode({
                x: currentBounds.x,
                y: currentBounds.y,
                width: Math.round(Number(width) || currentBounds.width),
                height: Math.round(Number(height) || currentBounds.height)
            }, this.overlayMode, this.config.overlayDensity);
            targetWindow.setBounds(nextBounds);
            this.persistOverlayBoundsForCurrentState(nextBounds);
            this.broadcastState();
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:resize-overlay-height', async (_event, height) => {
            const targetWindow = this.overlayWindow;
            if (!targetWindow || targetWindow.isDestroyed()) {
                return this.getSnapshot();
            }
            const currentBounds = targetWindow.getBounds();
            const nextBounds = this.normalizeOverlayBoundsForMode({
                ...currentBounds,
                height: Math.round(Number(height) || currentBounds.height)
            }, this.overlayMode, this.config.overlayDensity);
            targetWindow.setBounds(nextBounds);
            this.persistOverlayBoundsForCurrentState(nextBounds);
            this.broadcastState();
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:move-overlay-by', async (_event, deltaX, deltaY) => {
            const targetWindow = this.overlayWindow;
            if (!targetWindow || targetWindow.isDestroyed()) {
                return false;
            }
            const currentBounds = targetWindow.getBounds();
            const safeDeltaX = Math.max(-300, Math.min(300, Math.round(Number(deltaX) || 0)));
            const safeDeltaY = Math.max(-300, Math.min(300, Math.round(Number(deltaY) || 0)));
            if (safeDeltaX === 0 && safeDeltaY === 0) {
                return true;
            }
            const nextBounds = this.normalizeOverlayBoundsForMode({
                ...currentBounds,
                x: currentBounds.x + safeDeltaX,
                y: currentBounds.y + safeDeltaY
            }, this.overlayMode, this.config.overlayDensity);
            targetWindow.setBounds(nextBounds);
            return true;
        });
        electron_1.ipcMain.handle('app:set-overlay-mode', async (_event, mode) => {
            this.setOverlayMode(mode);
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:toggle-overlay-mode', async () => {
            this.toggleOverlayMode();
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:close-overlay', async () => this.requestCloseOverlayWindow());
        electron_1.ipcMain.handle('app:open-companion-panel', async () => {
            this.openCompanionWindow();
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:toggle-companion-panel', async () => {
            this.toggleCompanionWindow();
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:open-settings', async () => {
            this.openSettingsWindow();
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:toggle-settings', async () => {
            this.toggleSettingsWindow();
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:open-info', async () => {
            this.openInfoWindow();
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:open-community', async () => {
            this.openCommunityWindow();
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:open-support', async () => {
            this.openSupportWindow();
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:open-report-issue', async () => {
            this.openReportIssueWindow();
            return this.getSnapshot();
        });
        electron_1.ipcMain.handle('app:open-update-download', async (_event, url) => {
            if (!isSafeExternalUrl(url)) {
                return false;
            }
            await electron_1.shell.openExternal(url);
            return true;
        });
        electron_1.ipcMain.handle('app:open-release-page', async (_event, url) => {
            if (!isSafeExternalUrl(url)) {
                return false;
            }
            await electron_1.shell.openExternal(url);
            return true;
        });
        electron_1.ipcMain.handle('app:open-external', async (_event, url) => {
            if (!isSafeExternalUrl(url)) {
                return false;
            }
            await electron_1.shell.openExternal(url);
            return true;
        });
    }
    createOverlayWindow() {
        const bounds = this.getOverlayBoundsForMode(this.overlayMode);
        const minimumSize = this.getOverlayMinimumSize(this.overlayMode);
        this.overlayWindow = new electron_1.BrowserWindow({
            icon: createAppIcon(),
            ...bounds,
            frame: false,
            transparent: true,
            // Native resize is unstable with transparent frameless Electron windows on high-DPI
            // and Linux compositors. The app uses its own resize grip via setBounds instead.
            resizable: false,
            minWidth: minimumSize.width,
            minHeight: minimumSize.height,
            show: false,
            alwaysOnTop: true,
            skipTaskbar: false,
            // Keep the overlay focusable so local buttons and fallback hotkeys still work.
            // Showing is done through showInactive(), so the game should not lose focus on expand/show.
            focusable: true,
            hasShadow: false,
            backgroundColor: '#00000000',
            webPreferences: {
                preload: (0, node_path_1.join)(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                backgroundThrottling: false
            }
        });
        this.attachManualHotkeys(this.overlayWindow);
        this.overlayWindow.setAlwaysOnTop(true, 'screen-saver');
        this.overlayWindow.setVisibleOnAllWorkspaces(true, {
            visibleOnFullScreen: true
        });
        this.overlayWindow.setOpacity(this.config.overlayOpacity);
        this.overlayWindow.setMenuBarVisibility(false);
        this.overlayWindow.setFocusable(true);
        this.overlayWindow.on('close', (event) => {
            if (this.isClosingOverlayWindow) {
                return;
            }
            if (!this.isQuitting) {
                event.preventDefault();
                this.overlayWindow?.hide();
            }
        });
        this.overlayWindow.on('closed', () => {
            this.overlayWindow = null;
            this.isClosingOverlayWindow = false;
        });
        this.overlayWindow.on('move', () => {
            this.persistOverlayBounds();
        });
        this.overlayWindow.on('resize', () => {
            this.persistOverlayBounds();
        });
        void this.loadWindowPage(this.overlayWindow, 'overlay');
        this.overlayWindow.once('ready-to-show', () => {
            this.showOverlayInactive();
        });
    }
    getConfiguredHotkeys() {
        return {
            markChecklistDone: formatConfiguredHotkey(this.config.hotkeys.markChecklistDone, defaults_1.DEFAULT_HOTKEYS.markChecklistDone),
            undoChecklistMark: formatConfiguredHotkey(this.config.hotkeys.undoChecklistMark, defaults_1.DEFAULT_HOTKEYS.undoChecklistMark),
            toggleTimerPause: formatConfiguredHotkey(this.config.hotkeys.toggleTimerPause, defaults_1.DEFAULT_HOTKEYS.toggleTimerPause),
            openCompanion: formatConfiguredHotkey(this.config.hotkeys.openCompanion, defaults_1.DEFAULT_HOTKEYS.openCompanion),
            toggleOverlayMode: formatConfiguredHotkey(this.config.hotkeys.toggleOverlayMode, defaults_1.DEFAULT_HOTKEYS.toggleOverlayMode)
        };
    }
    registerGlobalHotkeys() {
        electron_1.globalShortcut.unregisterAll();
        this.registeredGlobalHotkeys.clear();
        this.globalHotkeysRegistered = false;
        const hotkeys = this.getConfiguredHotkeys();
        const shortcuts = [
            [
                'toggleTimerPause',
                hotkeys.toggleTimerPause,
                () => {
                    if (this.config.runTimer.status === 'running') {
                        this.pauseRunTimer();
                    }
                    else if (this.config.runTimer.status === 'paused') {
                        this.resumeRunTimer();
                    }
                }
            ],
            ['openCompanion', hotkeys.openCompanion, () => this.toggleCompanionWindow()],
            ['toggleOverlayMode', hotkeys.toggleOverlayMode, () => this.toggleOverlayMode()]
        ];
        if (this.config.manualHotkeysEnabled) {
            shortcuts.push(['markChecklistDone', hotkeys.markChecklistDone, () => this.markCurrentChecklistItemDone()], ['undoChecklistMark', hotkeys.undoChecklistMark, () => this.undoLastChecklistMark()]);
        }
        const usedAccelerators = new Map();
        for (const [action, accelerator, handler] of shortcuts) {
            const normalized = normalizeHotkeyAccelerator(accelerator);
            if (!normalized) {
                console.warn(`[Hotkeys] Invalid shortcut for ${action}: ${accelerator}`);
                continue;
            }
            const duplicateAction = usedAccelerators.get(normalized);
            if (duplicateAction) {
                console.warn(`[Hotkeys] Duplicate shortcut ${normalized} for ${action} and ${duplicateAction}. Skipping ${action}.`);
                continue;
            }
            usedAccelerators.set(normalized, action);
            const registered = electron_1.globalShortcut.register(normalized, () => {
                if (this.isQuitting) {
                    return;
                }
                handler();
            });
            if (!registered) {
                console.warn(`[Hotkeys] Failed to register global shortcut ${normalized} (${HOTKEY_ACTION_LABELS[action]}). Local fallback will work when overlay is focused.`);
                continue;
            }
            this.registeredGlobalHotkeys.add(normalized);
        }
        this.globalHotkeysRegistered = this.registeredGlobalHotkeys.size > 0;
        this.refreshTrayMenu();
    }
    getLocalInputAccelerator(input) {
        const key = String(input.key ?? '').trim();
        if (!key) {
            return null;
        }
        const parts = [];
        if (input.control || input.meta) {
            parts.push('Ctrl');
        }
        if (input.alt) {
            parts.push('Alt');
        }
        if (input.shift) {
            parts.push('Shift');
        }
        const upperKey = key.length === 1 ? key.toUpperCase() : key.toUpperCase();
        parts.push(upperKey === ' ' ? 'Space' : upperKey);
        return normalizeHotkeyAccelerator(parts.join('+'));
    }
    attachManualHotkeys(window) {
        window.webContents.on('before-input-event', (event, input) => {
            if (input.type !== 'keyDown') {
                return;
            }
            const inputAccelerator = this.getLocalInputAccelerator(input);
            if (!inputAccelerator || this.registeredGlobalHotkeys.has(inputAccelerator)) {
                return;
            }
            const hotkeys = this.getConfiguredHotkeys();
            const matches = (value) => normalizeHotkeyAccelerator(value) === inputAccelerator;
            if (matches(hotkeys.openCompanion)) {
                event.preventDefault();
                this.toggleCompanionWindow();
                return;
            }
            if (matches(hotkeys.toggleOverlayMode)) {
                event.preventDefault();
                this.toggleOverlayMode();
                return;
            }
            if (matches(hotkeys.toggleTimerPause)) {
                event.preventDefault();
                if (this.config.runTimer.status === 'running') {
                    this.pauseRunTimer();
                }
                else if (this.config.runTimer.status === 'paused') {
                    this.resumeRunTimer();
                }
                return;
            }
            if (!this.config.manualHotkeysEnabled) {
                return;
            }
            if (matches(hotkeys.markChecklistDone)) {
                event.preventDefault();
                this.markCurrentChecklistItemDone();
                return;
            }
            if (matches(hotkeys.undoChecklistMark)) {
                event.preventDefault();
                this.undoLastChecklistMark();
                return;
            }
        });
    }
    toggleSettingsWindow() {
        if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
            if (this.settingsWindow.isVisible()) {
                this.settingsWindow.hide();
                return;
            }
            if (this.settingsWindow.isMinimized()) {
                this.settingsWindow.restore();
            }
            this.settingsWindow.show();
            this.settingsWindow.focus();
            return;
        }
        this.openSettingsWindow();
    }
    openSettingsWindow() {
        if (this.settingsWindow) {
            this.settingsWindow.show();
            this.settingsWindow.focus();
            return;
        }
        this.settingsWindow = new electron_1.BrowserWindow({
            icon: createAppIcon(),
            width: 760,
            height: 860,
            minWidth: 680,
            minHeight: 720,
            frame: false,
            titleBarStyle: 'hidden',
            backgroundColor: '#10161f',
            show: false,
            autoHideMenuBar: true,
            webPreferences: {
                preload: (0, node_path_1.join)(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                backgroundThrottling: false
            }
        });
        this.attachManualHotkeys(this.settingsWindow);
        this.settingsWindow.on('close', (event) => {
            if (!this.isQuitting) {
                event.preventDefault();
                this.settingsWindow?.hide();
            }
        });
        this.settingsWindow.on('closed', () => {
            this.settingsWindow = null;
        });
        void this.loadWindowPage(this.settingsWindow, 'settings');
        this.settingsWindow.once('ready-to-show', () => {
            this.settingsWindow?.show();
        });
    }
    toggleCompanionWindow() {
        if (this.companionWindow && !this.companionWindow.isDestroyed()) {
            if (this.companionWindow.isVisible()) {
                this.companionWindow.hide();
                return;
            }
            if (this.companionWindow.isMinimized()) {
                this.companionWindow.restore();
            }
            this.companionWindow.show();
            this.companionWindow.focus();
            return;
        }
        this.openCompanionWindow();
    }
    openCompanionWindow() {
        if (this.companionWindow) {
            this.companionWindow.show();
            this.companionWindow.focus();
            return;
        }
        const bounds = this.getCompanionBounds();
        this.companionWindow = new electron_1.BrowserWindow({
            icon: createAppIcon(),
            ...bounds,
            minWidth: 720,
            minHeight: 520,
            resizable: true,
            show: false,
            autoHideMenuBar: true,
            backgroundColor: '#0f151d',
            alwaysOnTop: this.config.companionAlwaysOnTop,
            webPreferences: {
                preload: (0, node_path_1.join)(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                backgroundThrottling: false
            }
        });
        this.attachManualHotkeys(this.companionWindow);
        this.companionWindow.on('close', (event) => {
            if (!this.isQuitting) {
                event.preventDefault();
                this.companionWindow?.hide();
            }
        });
        this.companionWindow.on('closed', () => {
            this.companionWindow = null;
        });
        this.companionWindow.on('move', () => {
            this.persistCompanionBounds();
        });
        this.companionWindow.on('resize', () => {
            this.persistCompanionBounds();
        });
        void this.loadWindowPage(this.companionWindow, 'companion');
        this.companionWindow.once('ready-to-show', () => {
            this.companionWindow?.show();
        });
    }
    openInfoWindow() {
        if (this.infoWindow) {
            this.infoWindow.show();
            this.infoWindow.focus();
            return;
        }
        this.infoWindow = new electron_1.BrowserWindow({
            icon: createAppIcon(),
            width: 760,
            height: 760,
            minWidth: 680,
            minHeight: 620,
            frame: false,
            titleBarStyle: 'hidden',
            backgroundColor: '#10161f',
            show: false,
            autoHideMenuBar: true,
            webPreferences: {
                preload: (0, node_path_1.join)(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                backgroundThrottling: false
            }
        });
        this.attachManualHotkeys(this.infoWindow);
        this.infoWindow.on('close', (event) => {
            if (!this.isQuitting) {
                event.preventDefault();
                this.infoWindow?.hide();
            }
        });
        this.infoWindow.on('closed', () => {
            this.infoWindow = null;
        });
        void this.loadWindowPage(this.infoWindow, 'info');
        this.infoWindow.once('ready-to-show', () => {
            this.infoWindow?.show();
        });
    }
    openCommunityWindow() {
        if (this.communityWindow) {
            this.communityWindow.show();
            this.communityWindow.focus();
            return;
        }
        this.communityWindow = new electron_1.BrowserWindow({
            icon: createAppIcon(),
            width: 760,
            height: 680,
            minWidth: 680,
            minHeight: 560,
            frame: false,
            titleBarStyle: 'hidden',
            backgroundColor: '#10161f',
            show: false,
            autoHideMenuBar: true,
            webPreferences: {
                preload: (0, node_path_1.join)(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                backgroundThrottling: false
            }
        });
        this.attachManualHotkeys(this.communityWindow);
        this.communityWindow.on('close', (event) => {
            if (!this.isQuitting) {
                event.preventDefault();
                this.communityWindow?.hide();
            }
        });
        this.communityWindow.on('closed', () => {
            this.communityWindow = null;
        });
        void this.loadWindowPage(this.communityWindow, 'community');
        this.communityWindow.once('ready-to-show', () => {
            this.communityWindow?.show();
            this.communityWindow?.focus();
        });
    }
    openSupportWindow() {
        if (this.supportWindow) {
            this.supportWindow.show();
            this.supportWindow.focus();
            return;
        }
        this.supportWindow = new electron_1.BrowserWindow({
            icon: createAppIcon(),
            width: 760,
            height: 700,
            minWidth: 680,
            minHeight: 560,
            frame: false,
            titleBarStyle: 'hidden',
            backgroundColor: '#10161f',
            show: false,
            autoHideMenuBar: true,
            webPreferences: {
                preload: (0, node_path_1.join)(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                backgroundThrottling: false
            }
        });
        this.attachManualHotkeys(this.supportWindow);
        this.supportWindow.on('close', (event) => {
            if (!this.isQuitting) {
                event.preventDefault();
                this.supportWindow?.hide();
            }
        });
        this.supportWindow.on('closed', () => {
            this.supportWindow = null;
        });
        void this.loadWindowPage(this.supportWindow, 'support');
        this.supportWindow.once('ready-to-show', () => {
            this.supportWindow?.show();
            this.supportWindow?.focus();
        });
    }
    openReportIssueWindow() {
        if (this.reportWindow) {
            this.reportWindow.show();
            this.reportWindow.focus();
            return;
        }
        this.reportWindow = new electron_1.BrowserWindow({
            icon: createAppIcon(),
            width: 820,
            height: 780,
            minWidth: 720,
            minHeight: 620,
            frame: false,
            titleBarStyle: 'hidden',
            backgroundColor: '#10161f',
            show: false,
            autoHideMenuBar: true,
            webPreferences: {
                preload: (0, node_path_1.join)(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                backgroundThrottling: false
            }
        });
        this.attachManualHotkeys(this.reportWindow);
        this.reportWindow.on('close', (event) => {
            if (!this.isQuitting) {
                event.preventDefault();
                this.reportWindow?.hide();
            }
        });
        this.reportWindow.on('closed', () => {
            this.reportWindow = null;
        });
        void this.loadWindowPage(this.reportWindow, 'report');
        this.reportWindow.once('ready-to-show', () => {
            this.reportWindow?.show();
            this.reportWindow?.focus();
        });
    }
    createTray() {
        this.tray = new electron_1.Tray(createAppIcon());
        this.tray.setToolTip(this.t('main.trayTooltip'));
        this.refreshTrayMenu();
        this.tray.on('double-click', () => {
            this.showOverlay();
        });
    }
    getHotkeyTrayLabel() {
        const hotkeys = this.getConfiguredHotkeys();
        const segments = [];
        if (this.config.manualHotkeysEnabled) {
            segments.push(`${hotkeys.markChecklistDone} — ${this.t('main.hotkeysMark')}`);
            segments.push(`${hotkeys.undoChecklistMark} — ${this.t('main.hotkeysUndo')}`);
        }
        segments.push(`${hotkeys.toggleTimerPause} — ${this.t('main.hotkeysPause')}`);
        segments.push(`${hotkeys.openCompanion} — ${this.t('main.hotkeysCompanion')}`);
        segments.push(`${hotkeys.toggleOverlayMode} — ${this.t('main.hotkeysOverlayMode')}`);
        return `${this.t('main.hotkeysLabel')}: ${segments.join(', ')}`;
    }
    refreshTrayMenu() {
        if (!this.tray) {
            return;
        }
        this.tray.setToolTip(this.t('main.trayTooltip'));
        const menu = electron_1.Menu.buildFromTemplate([
            {
                label: this.t('main.trayShowOverlay'),
                click: () => this.showOverlay()
            },
            {
                label: this.t('main.trayHideOverlay'),
                click: () => this.overlayWindow?.hide()
            },
            {
                label: this.t('main.trayOpenCompanion'),
                click: () => this.openCompanionWindow()
            },
            {
                label: this.t('main.traySettings'),
                click: () => this.openSettingsWindow()
            },
            { type: 'separator' },
            {
                label: this.getHotkeyTrayLabel(),
                enabled: false
            },
            {
                label: this.t('main.trayQuit'),
                click: () => {
                    electron_1.app.quit();
                }
            }
        ]);
        this.tray.setContextMenu(menu);
    }
    async appendDevSampleLine() {
        const targetPath = this.config.logFilePath ?? this.runtime.watchedLogPath;
        if (!targetPath) {
            return;
        }
        await (0, promises_1.appendFile)(targetPath, `${DEV_SAMPLE_ZONE_LINE}\r\n`, 'utf8');
        await this.refreshLogFileInfo(targetPath);
        await this.logWatcher.checkNow();
        this.broadcastState();
    }
    async requestCloseOverlayWindow() {
        const targetWindow = this.overlayWindow;
        if (!targetWindow || targetWindow.isDestroyed()) {
            return false;
        }
        // The overlay X is treated as a real app close action, not "hide to tray".
        // If the timer is running, ask first; if the user stays, keep the overlay visible.
        if (this.config.runTimer.status !== 'running') {
            return this.quitApplicationFromOverlayClose();
        }
        if (this.isOverlayCloseConfirmationInFlight) {
            this.closeConfirmWindow?.show();
            this.closeConfirmWindow?.focus();
            return false;
        }
        this.isOverlayCloseConfirmationInFlight = true;
        let shouldCloseApplication = false;
        try {
            const customResult = await this.showCustomQuitConfirmation();
            if (customResult === 'close_and_save') {
                shouldCloseApplication = true;
            }
            else if (customResult === null) {
                shouldCloseApplication = await this.showNativeQuitConfirmation();
            }
            if (!shouldCloseApplication) {
                this.showOverlayInactive();
                return false;
            }
            this.pauseRunTimerForQuit(Date.now());
            return this.quitApplicationFromOverlayClose();
        }
        catch (error) {
            console.error('[Overlay] Failed to confirm app close while timer is running.', error);
            this.showOverlayInactive();
            return false;
        }
        finally {
            this.isOverlayCloseConfirmationInFlight = false;
        }
    }
    quitApplicationFromOverlayClose() {
        try {
            if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
                this.persistOverlayBoundsForCurrentState(this.overlayWindow.getBounds());
            }
        }
        catch {
            // Bounds persistence is best-effort; quitting must still work.
        }
        this.isQuittingConfirmed = true;
        this.prepareForQuit();
        electron_1.app.quit();
        return true;
    }
    closeOverlayWindow() {
        const targetWindow = this.overlayWindow;
        if (!targetWindow || targetWindow.isDestroyed()) {
            return false;
        }
        this.isClosingOverlayWindow = true;
        try {
            this.persistOverlayBoundsForCurrentState(targetWindow.getBounds());
        }
        catch {
            // Bounds persistence is best-effort; closing must still work.
        }
        targetWindow.close();
        return true;
    }
    showOverlayInactive() {
        if (!this.overlayWindow || this.overlayWindow.isDestroyed()) {
            return;
        }
        // Show without activating the window. The overlay remains focusable for mouse buttons
        // and fallback local hotkeys, but showInactive() keeps the game focused on show/expand.
        this.overlayWindow.setFocusable(true);
        this.overlayWindow.setAlwaysOnTop(true, 'screen-saver');
        this.overlayWindow.showInactive();
    }
    showOverlay() {
        if (!this.overlayWindow || this.overlayWindow.isDestroyed()) {
            this.createOverlayWindow();
            return;
        }
        this.showOverlayInactive();
    }
    setOverlayMode(mode) {
        if (this.overlayMode === mode && this.runtime.overlayMode === mode) {
            return;
        }
        const previousOverlayMode = this.overlayMode;
        const previousOverlayDensity = this.config.overlayDensity;
        const previousOverlayBounds = this.overlayWindow && !this.overlayWindow.isDestroyed()
            ? this.overlayWindow.getBounds()
            : null;
        if (previousOverlayBounds) {
            if (this.overlayBoundsTimer) {
                clearTimeout(this.overlayBoundsTimer);
                this.overlayBoundsTimer = null;
            }
            this.persistOverlayBoundsForState(previousOverlayMode, previousOverlayDensity, previousOverlayBounds);
        }
        this.overlayMode = mode;
        this.runtime.overlayMode = mode;
        this.config = this.configStore.updateSettings({
            mainOverlaySettings: {
                overlayMode: mode
            }
        });
        if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
            const minimumSize = this.getOverlayMinimumSize(mode);
            const nextBounds = this.getOverlayBoundsForMode(mode);
            this.overlayWindow.setMinimumSize(minimumSize.width, minimumSize.height);
            this.overlayWindow.setBounds(nextBounds);
            this.overlayWindow.setFocusable(true);
            this.overlayWindow.setAlwaysOnTop(true, 'screen-saver');
            if (this.overlayWindow.isVisible()) {
                this.overlayWindow.showInactive();
            }
        }
        this.broadcastState();
    }
    toggleOverlayMode() {
        if (this.overlayMode === 'timer_only') {
            if (this.config.overlayDensity === 'compact') {
                this.config = this.configStore.updateSettings({
                    overlayDensity: 'normal'
                });
            }
            this.setOverlayMode('full');
            return;
        }
        this.setOverlayMode('timer_only');
    }
    async loadWindowPage(window, page) {
        if (isDev) {
            try {
                await window.loadURL(`${devServerUrl}/${page}.html`);
                return;
            }
            catch {
                // If Vite is not running, fall back to built files.
            }
        }
        await window.loadFile((0, runtime_paths_1.resolveRuntimePath)('dist', `${page}.html`));
    }
    getStartupOverlayMode() {
        return this.config.mainOverlaySettings.overlayTimerOnlyMode
            ? 'timer_only'
            : this.config.mainOverlaySettings.overlayMode;
    }
    getOverlayMinimumSize(mode, density = this.config.overlayDensity, scale = this.config.overlayScale) {
        return (0, overlay_layout_1.getOverlayMinimumSize)(mode, density, scale);
    }
    getOverlayMaximumOffscreenX(width) {
        return Math.min(120, Math.round(width * 0.35));
    }
    getOverlayMinimumVisibleWidth(width) {
        return Math.min(width, Math.max(120, Math.min(160, Math.round(width * 0.4))));
    }
    getOverlayMinimumVisibleHeight(height) {
        return Math.min(height, 120);
    }
    getOverlayScaledDefaultBounds(mode, density = this.config.overlayDensity) {
        const minimumSize = this.getOverlayMinimumSize(mode, density);
        if (mode === 'timer_only') {
            return {
                width: Math.max(minimumSize.width, Math.round((defaults_1.DEFAULT_TIMER_ONLY_OVERLAY_BOUNDS.width * this.config.overlayScale) / 100)),
                height: Math.max(minimumSize.height, Math.round((defaults_1.DEFAULT_TIMER_ONLY_OVERLAY_BOUNDS.height * this.config.overlayScale) / 100))
            };
        }
        if (density === 'compact') {
            return {
                width: Math.max(minimumSize.width, Math.round((defaults_1.DEFAULT_COMPACT_OVERLAY_BOUNDS.width * this.config.overlayScale) / 100)),
                height: Math.max(minimumSize.height, Math.round((defaults_1.DEFAULT_COMPACT_OVERLAY_BOUNDS.height * this.config.overlayScale) / 100))
            };
        }
        return {
            width: Math.max(minimumSize.width, Math.round((defaults_1.DEFAULT_OVERLAY_BOUNDS.width * this.config.overlayScale) / 100)),
            height: Math.max(minimumSize.height, Math.round((defaults_1.DEFAULT_OVERLAY_BOUNDS.height * this.config.overlayScale) / 100))
        };
    }
    getOverlayVirtualWorkArea() {
        const displays = electron_1.screen.getAllDisplays();
        if (displays.length === 0) {
            return electron_1.screen.getPrimaryDisplay().workArea;
        }
        const left = Math.min(...displays.map((display) => display.workArea.x));
        const top = Math.min(...displays.map((display) => display.workArea.y));
        const right = Math.max(...displays.map((display) => display.workArea.x + display.workArea.width));
        const bottom = Math.max(...displays.map((display) => display.workArea.y + display.workArea.height));
        return {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top
        };
    }
    normalizeOverlayBoundsForMode(bounds, mode, density = this.config.overlayDensity) {
        const minimumSize = this.getOverlayMinimumSize(mode, density);
        const roundedBounds = {
            x: Math.round(bounds.x),
            y: Math.round(bounds.y),
            width: Math.round(bounds.width),
            height: Math.round(bounds.height)
        };
        const display = electron_1.screen.getDisplayMatching(roundedBounds);
        const area = display.workArea;
        const virtualArea = this.getOverlayVirtualWorkArea();
        const width = Math.min(Math.max(minimumSize.width, area.width), Math.max(minimumSize.width, roundedBounds.width));
        const height = Math.min(Math.max(minimumSize.height, area.height - 16), Math.max(minimumSize.height, roundedBounds.height));
        const minVisibleWidth = this.getOverlayMinimumVisibleWidth(width);
        const minVisibleHeight = this.getOverlayMinimumVisibleHeight(height);
        const minX = virtualArea.x - this.getOverlayMaximumOffscreenX(width);
        const maxX = virtualArea.x + virtualArea.width - minVisibleWidth;
        const minY = virtualArea.y;
        const maxY = virtualArea.y + virtualArea.height - minVisibleHeight;
        return {
            x: Math.min(Math.max(roundedBounds.x, minX), Math.max(minX, maxX)),
            y: Math.min(Math.max(roundedBounds.y, minY), Math.max(minY, maxY)),
            width,
            height
        };
    }
    isBoundsVisible(bounds) {
        return electron_1.screen.getAllDisplays().some((display) => {
            const area = display.workArea;
            const intersectionWidth = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
            const intersectionHeight = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
            return (intersectionWidth >= this.getOverlayMinimumVisibleWidth(bounds.width) &&
                intersectionHeight >= this.getOverlayMinimumVisibleHeight(bounds.height));
        });
    }
    getFullOverlayFallbackBounds() {
        const fallbackDisplay = electron_1.screen.getPrimaryDisplay();
        const fallbackWorkArea = fallbackDisplay.workArea;
        const defaultBounds = this.getOverlayScaledDefaultBounds('full', 'normal');
        return {
            x: fallbackWorkArea.x + Math.max(20, fallbackWorkArea.width - defaultBounds.width - 40),
            y: fallbackWorkArea.y + 80,
            width: defaultBounds.width,
            height: defaultBounds.height
        };
    }
    getTimerOnlyOverlayFallbackBounds() {
        const baseBounds = this.config.overlayBounds ?? this.getFullOverlayFallbackBounds();
        const defaultBounds = this.getOverlayScaledDefaultBounds('timer_only');
        return {
            x: baseBounds.x,
            y: baseBounds.y,
            width: Math.max(this.getOverlayMinimumSize('timer_only').width, Math.min(baseBounds.width, defaultBounds.width)),
            height: defaultBounds.height
        };
    }
    getCompactOverlayFallbackBounds() {
        const baseBounds = this.config.overlayBounds ?? this.getFullOverlayFallbackBounds();
        const defaultBounds = this.getOverlayScaledDefaultBounds('full', 'compact');
        return {
            x: baseBounds.x,
            y: baseBounds.y,
            width: Math.max(this.getOverlayMinimumSize('full', 'compact').width, Math.min(baseBounds.width, defaultBounds.width)),
            height: Math.max(this.getOverlayMinimumSize('full', 'compact').height, Math.min(baseBounds.height, defaultBounds.height))
        };
    }
    getSavedOverlayBoundsForState(mode, density = this.config.overlayDensity) {
        if (mode === 'timer_only') {
            return this.config.overlayTimerOnlyBounds;
        }
        if (density === 'compact') {
            return this.config.overlayCompactBounds;
        }
        return this.config.overlayBounds;
    }
    getFallbackOverlayBoundsForState(mode, density = this.config.overlayDensity) {
        if (mode === 'timer_only') {
            return this.getTimerOnlyOverlayFallbackBounds();
        }
        if (density === 'compact') {
            return this.getCompactOverlayFallbackBounds();
        }
        return this.getFullOverlayFallbackBounds();
    }
    getOverlayBoundsForMode(mode, density = this.config.overlayDensity) {
        const saved = this.getSavedOverlayBoundsForState(mode, density);
        const fallbackBounds = this.getFallbackOverlayBoundsForState(mode, density);
        if (!saved || !this.isBoundsVisible(saved)) {
            return this.normalizeOverlayBoundsForMode(fallbackBounds, mode, density);
        }
        return this.normalizeOverlayBoundsForMode({
            x: saved.x,
            y: saved.y,
            width: saved.width,
            height: saved.height
        }, mode, density);
    }
    getCompanionBounds() {
        const fallbackDisplay = electron_1.screen.getPrimaryDisplay();
        const fallbackWorkArea = fallbackDisplay.workArea;
        const fallbackBounds = {
            x: Math.max(0, fallbackWorkArea.x + Math.floor((fallbackWorkArea.width - defaults_1.DEFAULT_COMPANION_BOUNDS.width) / 2)),
            y: Math.max(20, fallbackWorkArea.y + 60),
            width: defaults_1.DEFAULT_COMPANION_BOUNDS.width,
            height: defaults_1.DEFAULT_COMPANION_BOUNDS.height
        };
        const saved = this.config.companionBounds;
        if (!saved) {
            return fallbackBounds;
        }
        const visibleOnSomeDisplay = electron_1.screen.getAllDisplays().some((display) => {
            const area = display.workArea;
            return (saved.x < area.x + area.width - 80 &&
                saved.x + saved.width > area.x + 80 &&
                saved.y < area.y + area.height - 80 &&
                saved.y + saved.height > area.y + 80);
        });
        if (!visibleOnSomeDisplay) {
            return fallbackBounds;
        }
        return {
            x: saved.x,
            y: saved.y,
            width: Math.max(720, saved.width),
            height: Math.max(520, saved.height)
        };
    }
    persistOverlayBoundsForState(mode, density, bounds) {
        if (mode === 'timer_only') {
            this.config = this.configStore.setOverlayTimerOnlyBounds(bounds);
            return;
        }
        this.config = density === 'compact'
            ? this.configStore.setOverlayCompactBounds(bounds)
            : this.configStore.setOverlayBounds(bounds);
    }
    persistOverlayBoundsForCurrentState(bounds) {
        this.persistOverlayBoundsForState(this.overlayMode, this.config.overlayDensity, bounds);
    }
    persistOverlayBoundsImmediately() {
        if (!this.overlayWindow || this.overlayWindow.isDestroyed()) {
            return;
        }
        if (this.overlayBoundsTimer) {
            clearTimeout(this.overlayBoundsTimer);
            this.overlayBoundsTimer = null;
        }
        this.persistOverlayBoundsForCurrentState(this.overlayWindow.getBounds());
    }
    persistOverlayBounds() {
        if (!this.overlayWindow) {
            return;
        }
        if (this.overlayBoundsTimer) {
            clearTimeout(this.overlayBoundsTimer);
        }
        this.overlayBoundsTimer = setTimeout(() => {
            if (!this.overlayWindow || this.overlayWindow.isDestroyed()) {
                return;
            }
            const bounds = this.overlayWindow.getBounds();
            this.persistOverlayBoundsForCurrentState(bounds);
            this.broadcastState();
        }, 350);
    }
    persistCompanionBounds() {
        if (!this.companionWindow) {
            return;
        }
        if (this.companionBoundsTimer) {
            clearTimeout(this.companionBoundsTimer);
        }
        this.companionBoundsTimer = setTimeout(() => {
            if (!this.companionWindow || this.companionWindow.isDestroyed()) {
                return;
            }
            const bounds = this.companionWindow.getBounds();
            this.config = this.configStore.setCompanionBounds(bounds);
            this.broadcastState();
        }, 350);
    }
    loadGuide() {
        try {
            this.guideService.load();
            this.runtime.guideLoadedAt = this.guideService.getLoadedAt();
        }
        catch (error) {
            const message = error instanceof Error && error.message
                ? `${this.t('main.guideLoadError')}: ${error.message}`
                : this.t('main.guideLoadError');
            this.setLogStatus('error', message);
        }
    }
    restoreLastZoneFromConfig() {
        if (!this.config.lastZoneName) {
            return;
        }
        this.currentZone = {
            rawZoneName: this.config.lastZoneName,
            guide: this.guideService.findByZoneName(this.config.lastZoneName),
            sceneKind: this.guideService.findByZoneName(this.config.lastZoneName)
                ? 'gameplay'
                : 'unknown',
            actHint: this.guideService.findByZoneName(this.config.lastZoneName)?.act ?? null
        };
        this.syncRuntimeZoneFields(this.config.lastZoneName, this.currentZone.guide);
        this.runtime.lastZoneSource = 'config';
    }
    rebindCurrentZoneAfterGuideReload() {
        const currentGuideId = this.currentZone.guide?.id ?? this.runtime.lastMatchedGuideId;
        const reboundGuide = this.guideService.findById(currentGuideId) ??
            this.guideService.findByZoneName(this.currentZone.rawZoneName);
        this.currentZone = {
            rawZoneName: this.currentZone.rawZoneName,
            guide: reboundGuide,
            sceneKind: this.currentZone.sceneKind === 'town' || this.currentZone.sceneKind === 'login'
                ? this.currentZone.sceneKind
                : reboundGuide
                    ? 'gameplay'
                    : this.currentZone.sceneKind,
            actHint: reboundGuide?.act ?? this.currentZone.actHint
        };
        this.syncRuntimeZoneFields(this.currentZone.rawZoneName, this.currentZone.guide);
    }
    async ensureLogFile() {
        if (this.config.logFilePath) {
            const shouldPreservePath = this.config.logFileSelectionMode !== 'auto';
            if (shouldPreservePath || (await this.isReadable(this.config.logFilePath))) {
                await this.refreshLogFileInfo(this.config.logFilePath);
                return;
            }
        }
        const discoveredPath = await this.findAutoLogFile();
        if (discoveredPath) {
            this.config = this.configStore.update({
                logFilePath: discoveredPath,
                logFileSelectionMode: 'auto'
            });
            await this.refreshLogFileInfo(discoveredPath);
            return;
        }
        this.config = this.configStore.update({
            logFilePath: this.config.logFileSelectionMode === 'manual' ? this.config.logFilePath : null,
            logFileSelectionMode: this.config.logFileSelectionMode === 'manual'
                ? 'manual'
                : null
        });
        await this.refreshLogFileInfo(this.config.logFilePath);
        if (!this.config.logFilePath) {
            this.setLogStatus('missing', this.t('system.logWatcher.missingManual'));
        }
    }
    async findAutoLogFile() {
        const documents = electron_1.app.getPath('documents');
        const baseDirectories = [
            (0, node_path_1.join)(documents, 'My Games', 'Path of Exile 2', 'logs'),
            (0, node_path_1.join)(documents, 'My Games', 'Path of Exile 2'),
            'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Path of Exile 2\\logs',
            'C:\\Program Files\\Steam\\steamapps\\common\\Path of Exile 2\\logs',
            'E:\\Steam\\steamapps\\common\\Path of Exile 2\\logs'
        ];
        const fileNamesByPriority = ['LatestClient.txt', 'Client.txt'];
        const candidates = fileNamesByPriority.flatMap((fileName) => baseDirectories.map((directory) => (0, node_path_1.join)(directory, fileName)));
        for (const candidate of candidates) {
            if (await this.isReadable(candidate)) {
                return candidate;
            }
        }
        return null;
    }
    async isReadable(filePath) {
        try {
            await (0, promises_1.access)(filePath, node_fs_1.constants.R_OK);
            return true;
        }
        catch {
            return false;
        }
    }
    clearLogFileInfoRefreshTimer() {
        if (this.logInfoRefreshTimer) {
            clearTimeout(this.logInfoRefreshTimer);
            this.logInfoRefreshTimer = null;
        }
    }
    scheduleLogFileInfoRefresh() {
        if (this.isQuitting) {
            return;
        }
        this.clearLogFileInfoRefreshTimer();
        this.logInfoRefreshTimer = setTimeout(() => {
            this.logInfoRefreshTimer = null;
            void this.refreshLogFileInfo();
        }, 250);
    }
    async refreshLogFileInfo(filePath = this.config.logFilePath) {
        const nextPath = filePath ?? null;
        let nextExists = false;
        let nextSize = null;
        if (nextPath) {
            try {
                const fileStat = await (0, promises_1.stat)(nextPath);
                if (fileStat.isFile()) {
                    nextExists = true;
                    nextSize = fileStat.size;
                }
            }
            catch {
                nextExists = false;
                nextSize = null;
            }
        }
        const hasChanges = this.runtime.logFileExists !== nextExists ||
            this.runtime.logFileSize !== nextSize;
        this.runtime.logFileExists = nextExists;
        this.runtime.logFileSize = nextSize;
        if (hasChanges) {
            this.broadcastState();
        }
    }
    async startLogWatcher(filePath, skipBootstrap = false) {
        await this.refreshLogFileInfo(filePath);
        this.pendingZoneAreaId = null;
        await this.logWatcher.start(filePath, { skipBootstrap });
        if (skipBootstrap && this.config.ignoreExistingLogOnNextStart) {
            this.config = this.configStore.update({
                ignoreExistingLogOnNextStart: false
            });
        }
        this.scheduleLogFileInfoRefresh();
        this.broadcastState();
    }
    setCurrentZone(rawZoneName, source, guide = this.guideService.findByZoneName(rawZoneName), actHint = null) {
        if (!guide) {
            this.setSceneWithoutGuide(rawZoneName, source, 'gameplay', actHint);
            return;
        }
        const now = Date.now();
        const previousGuide = this.currentZone.guide;
        const previousGuideId = previousGuide?.id ?? null;
        const nextGuideId = guide.id;
        const sceneChanged = this.currentZone.sceneKind !== 'gameplay' ||
            previousGuideId !== nextGuideId;
        if (previousGuide && previousGuideId !== nextGuideId) {
            this.handleZoneLeave(previousGuide);
        }
        else if (!previousGuide) {
            this.clearMissedWarning();
        }
        this.currentZone = {
            rawZoneName,
            guide,
            sceneKind: 'gameplay',
            actHint: guide.act
        };
        this.runtime.lastGameplayGuideId = guide.id;
        this.runtime.lastGameplayZoneRu = guide.zone_ru;
        this.runtime.lastGameplayAct = guide.act;
        this.runtime.lastValidGameplayZoneAt = new Date().toISOString();
        this.syncRuntimeZoneFields(rawZoneName, guide);
        this.runtime.lastZoneSource = source;
        this.updateZoneProgress(guide);
        this.config = this.configStore.update({
            lastZoneName: guide.zone_ru
        });
        if (sceneChanged) {
            this.recordVisitedZone(guide, now);
            this.handleRunTimerAfterZoneEntered(previousGuide, guide, now);
        }
        this.broadcastState();
    }
    handleZoneLeave(_previousGuide) {
        // Do not mark missed rewards anymore. The overlay is a guide/reminder,
        // not a pass/fail checklist.
        this.clearMissedWarning();
    }
    getRunTimerDisplayElapsedMs(now = Date.now()) {
        return (0, timers_1.getRunTimerDisplayElapsed)(this.config.runTimer, now);
    }
    getCurrentZoneElapsedMs(now = Date.now()) {
        return (0, timers_1.getZoneTimerDisplayElapsed)(this.config.runTimer, now);
    }
    getCurrentTownElapsedMs(_now = Date.now()) {
        return 0;
    }
    getTotalTownElapsedMs(_now = Date.now()) {
        return 0;
    }
    setSceneWithoutGuide(rawZoneName, source, sceneKind, actHint = null) {
        const now = Date.now();
        const previousActHint = this.currentZone.guide?.act ?? this.currentZone.actHint ?? this.runtime.lastGameplayAct ?? null;
        const nextActHint = this.getFallbackActHintForScene(sceneKind, actHint);
        this.currentZone = {
            rawZoneName,
            guide: sceneKind === 'gameplay' || sceneKind === 'unknown' ? null : this.currentZone.guide,
            sceneKind,
            actHint: nextActHint
        };
        if ((sceneKind === 'gameplay' || sceneKind === 'unknown') && typeof nextActHint === 'number') {
            this.runtime.lastGameplayAct = nextActHint;
            this.runtime.lastValidGameplayZoneAt = new Date(now).toISOString();
            this.recordActTransitionByHint(previousActHint, nextActHint, now);
        }
        this.syncRuntimeZoneFields(rawZoneName, this.currentZone.guide);
        this.runtime.lastZoneSource = source;
        this.config = this.configStore.update({
            lastZoneName: rawZoneName
        });
        this.broadcastState();
    }
    setTownScene(rawZoneName, source) {
        const now = Date.now();
        const sceneChanged = this.currentZone.rawZoneName !== rawZoneName ||
            this.currentZone.sceneKind !== 'town';
        const matchedTownGuide = rawZoneName ? this.guideService.findByZoneName(rawZoneName) : null;
        const nextTownGuide = matchedTownGuide ??
            (this.normalizeSceneSource(rawZoneName) === 'clearfell encampment'
                ? null
                : this.currentZone.guide);
        // Town/hub scenes are part of the run. Do not pause timers and do not
        // start separate town tracking.
        this.currentZone = {
            rawZoneName,
            guide: nextTownGuide,
            sceneKind: 'town',
            actHint: nextTownGuide?.act ?? this.currentZone.actHint ?? this.runtime.lastGameplayAct ?? null
        };
        this.syncRuntimeZoneFields(rawZoneName, this.currentZone.guide);
        this.runtime.lastZoneSource = source;
        this.updateZoneProgress(this.currentZone.guide);
        this.config = this.configStore.update({
            lastZoneName: rawZoneName
        });
        this.broadcastState();
    }
    recordVisitedZone(guide, enteredAt) {
        const existing = this.config.visitedZones.find((entry) => entry.zoneId === guide.id);
        const nextVisitedZones = existing
            ? this.config.visitedZones.map((entry) => entry.zoneId === guide.id
                ? {
                    ...entry,
                    lastEnteredAt: enteredAt,
                    visitCount: entry.visitCount + 1
                }
                : entry)
            : [
                ...this.config.visitedZones,
                {
                    zoneId: guide.id,
                    zone_ru: guide.zone_ru,
                    act: guide.act,
                    firstEnteredAt: enteredAt,
                    lastEnteredAt: enteredAt,
                    visitCount: 1
                }
            ];
        this.config = this.configStore.update({
            visitedZones: nextVisitedZones
        });
    }
    openTownVisit(_townName, _now) {
        // Town timer removed: towns are not tracked separately.
    }
    closeTownVisit(_now) {
        // Town timer removed: nothing to close.
    }
    handleRunTimerAfterTownEntered(_now) {
        // Towns no longer close or pause the active gameplay zone timer.
        // We keep only the global run timer and act splits in the UI.
    }
    recordZoneTimeEntry(guide, now) {
        const runTimer = this.config.runTimer;
        const enteredAt = runTimer.lastZoneEnteredAt ??
            (runTimer.pausedAt !== null
                ? Math.max(0, runTimer.pausedAt - runTimer.currentZoneElapsedMs)
                : null);
        if (!guide || enteredAt === null) {
            return;
        }
        const elapsedMs = runTimer.status === 'running'
            ? this.getCurrentZoneElapsedMs(now)
            : runTimer.currentZoneElapsedMs;
        if (elapsedMs <= 0) {
            return;
        }
        const nextEntry = {
            zoneId: guide.id,
            zone_ru: guide.zone_ru,
            act: guide.act,
            elapsedMs,
            enteredAt,
            leftAt: now
        };
        const previousEntry = this.config.zoneTimeHistory[this.config.zoneTimeHistory.length - 1];
        if (previousEntry &&
            previousEntry.zoneId === nextEntry.zoneId &&
            previousEntry.enteredAt === nextEntry.enteredAt) {
            return;
        }
        this.config = this.configStore.update({
            zoneTimeHistory: [...this.config.zoneTimeHistory, nextEntry]
        });
    }
    collectVisitedGuides() {
        const visitedIds = new Set(this.config.visitedZones.map((entry) => entry.zoneId));
        return this.guideService
            .getAll()
            .filter((guide) => guide.id === this.currentZone.guide?.id || visitedIds.has(guide.id));
    }
    buildRunSummary(runTimer, totalElapsedMs, finishedAt) {
        const longestZones = [...this.config.zoneTimeHistory]
            .sort((left, right) => right.elapsedMs - left.elapsedMs)
            .slice(0, 5);
        const previousPb = this.config.bestRun;
        const isNewPb = previousPb === null || totalElapsedMs < previousPb.totalElapsedMs;
        return {
            totalElapsedMs,
            finishedAt,
            actSplits: [...runTimer.actSplits],
            missedRequiredRewards: [],
            skippedRequiredItems: [],
            unfinishedChecklistItems: [],
            pauseCount: runTimer.pauseCount,
            longestZones,
            townTimeTotalMs: 0,
            isNewPb
        };
    }
    getActiveLevelReminder() {
        return this.guideService.findVendorCheckpointById(this.config.levelRemindersState.activeLevelReminderId);
    }
    normalizeSceneSource(rawSceneSource) {
        return normalizeSceneText(rawSceneSource);
    }
    getZoneMatchActHint(zoneMatch) {
        return zoneMatch?.guide?.act ?? inferActHintFromInternalAreaId(zoneMatch?.extractedInternalAreaId) ?? null;
    }
    getFallbackActHintForScene(sceneKind, explicitActHint = null) {
        if (explicitActHint !== null && explicitActHint !== undefined) {
            return explicitActHint;
        }
        if (sceneKind === 'gameplay' || sceneKind === 'unknown' || sceneKind === 'town') {
            return this.currentZone.guide?.act ?? this.currentZone.actHint ?? this.runtime.lastGameplayAct ?? null;
        }
        return this.currentZone.actHint;
    }
    isUnknownOrNullScene(rawSceneSource) {
        const normalized = this.normalizeSceneSource(rawSceneSource);
        return normalized === '(null)' || normalized === '(unknown)' || normalized === 'null' || normalized === 'unknown';
    }
    isActLabelScene(rawSceneSource) {
        const normalized = this.normalizeSceneSource(rawSceneSource);
        return /^акт\s+\d+$/.test(normalized) || /^act\s+\d+$/.test(normalized);
    }
    isLoginLikeScene(rawSceneSource) {
        const normalized = this.normalizeSceneSource(rawSceneSource);
        if (!normalized) {
            return false;
        }
        return LOGIN_SCENE_HINTS.some((hint) => normalized.includes(hint));
    }
    isTownScene(rawSceneSource) {
        return this.isTownSceneWithGuide(rawSceneSource, rawSceneSource ? this.guideService.findByZoneName(rawSceneSource) : null);
    }
    isTownSceneWithGuide(rawSceneSource, guide) {
        const normalized = this.normalizeSceneSource(rawSceneSource);
        if (!normalized) {
            return false;
        }
        if (guide) {
            return false;
        }
        if (TOWN_SCENES.has(normalized)) {
            return true;
        }
        return TOWN_ZONE_HINTS.some((hint) => normalized.includes(hint));
    }
    isValidGameplaySceneSource(rawSceneSource, guide = rawSceneSource ? this.guideService.findByZoneName(rawSceneSource) : null) {
        const normalized = this.normalizeSceneSource(rawSceneSource);
        if (!normalized) {
            return false;
        }
        if (this.isTownSceneWithGuide(rawSceneSource, guide)) {
            return false;
        }
        if (guide) {
            return true;
        }
        if (NON_GAMEPLAY_SCENES.has(normalized)) {
            return false;
        }
        if (this.isActLabelScene(rawSceneSource) || this.isLoginLikeScene(rawSceneSource)) {
            return false;
        }
        return true;
    }
    getIgnoredZoneEventReason(zoneMatch) {
        const currentGuideId = this.currentZone.guide?.id ?? null;
        const matchedGuideId = zoneMatch.guide?.id ?? null;
        if (matchedGuideId &&
            currentGuideId === matchedGuideId &&
            this.currentZone.sceneKind === 'gameplay') {
            return `same guide zone already active (${matchedGuideId})`;
        }
        // If the log names a gameplay scene but we do not have a guide entry for it,
        // do not keep the previous guide zone. Show an explicit “no info for this location”
        // state instead, so the overlay does not lie about the current location.
        return null;
    }
    logZoneEventDecision(zoneMatch, action, reason) {
        console.info('[ZoneEvent] Processed zone event', {
            rawLine: zoneMatch.rawLine,
            extractedInternalAreaId: zoneMatch.extractedInternalAreaId,
            extractedZoneName: zoneMatch.extractedZoneName,
            normalizedZoneName: zoneMatch.normalizedZoneName,
            source: zoneMatch.source,
            matchedGuideZoneId: zoneMatch.guide?.id ?? null,
            matchedGuideZoneRu: zoneMatch.guide?.zone_ru ?? null,
            currentZoneUpdated: action === 'updated',
            currentZoneIgnored: action === 'ignored',
            reason: reason ?? null
        });
    }
    shouldKeepPendingZoneAreaId(zoneName) {
        return PENDING_AREA_ID_HOLD_SCENES.has(normalizeSceneText(zoneName));
    }
    extractZoneMatchFromLogLine(line) {
        const trimmedLine = String(line ?? '').replace(/\u0000/g, '').trim();
        if (!trimmedLine) {
            return null;
        }
        const extractedInternalAreaId = (0, log_parser_1.extractGeneratedAreaId)(trimmedLine)?.trim() ?? null;
        if (extractedInternalAreaId) {
            this.pendingZoneAreaId = extractedInternalAreaId;
        }
        const extractedZoneName = (0, log_parser_1.extractNamedZoneFromLine)(trimmedLine)?.trim() ?? null;
        if (extractedZoneName) {
            const zoneMatch = this.guideService.resolveZoneMatch({
                rawLine: trimmedLine,
                extractedInternalAreaId: this.pendingZoneAreaId,
                extractedZoneName
            });
            if (!this.shouldKeepPendingZoneAreaId(extractedZoneName)) {
                this.pendingZoneAreaId = null;
            }
            return zoneMatch;
        }
        return this.guideService.extractZoneMatchFromLine(trimmedLine);
    }
    processRunTimerActivityFromLogLine(line, source) {
        const nowIso = new Date().toISOString();
        const zoneMatch = this.extractZoneMatchFromLogLine(line);
        if (!zoneMatch) {
            return;
        }
        const rawSceneSource = zoneMatch.rawZoneName;
        this.runtime.lastSceneSource = rawSceneSource;
        this.runtime.lastSceneSourceAt = nowIso;
        const matchedGuide = zoneMatch.guide;
        this.runtime.lastMatcherReason = zoneMatch.matcherReason;
        const ignoredReason = this.getIgnoredZoneEventReason(zoneMatch);
        if (source === 'bootstrap') {
            if (this.isTownSceneWithGuide(rawSceneSource, matchedGuide)) {
                const matchedTownGuide = rawSceneSource ? this.guideService.findByZoneName(rawSceneSource) : null;
                const nextTownGuide = matchedTownGuide ??
                    (this.normalizeSceneSource(rawSceneSource) === 'clearfell encampment'
                        ? null
                        : this.currentZone.guide);
                this.currentZone = {
                    rawZoneName: rawSceneSource,
                    guide: nextTownGuide,
                    sceneKind: 'town',
                    actHint: nextTownGuide?.act ?? this.currentZone.actHint ?? this.runtime.lastGameplayAct ?? null
                };
                this.syncRuntimeZoneFields(rawSceneSource, this.currentZone.guide);
                this.logZoneEventDecision(zoneMatch, 'updated');
            }
            else if (this.isValidGameplaySceneSource(rawSceneSource, matchedGuide)) {
                if (ignoredReason) {
                    this.logZoneEventDecision(zoneMatch, 'ignored', ignoredReason);
                    return;
                }
                this.currentZone = {
                    rawZoneName: rawSceneSource,
                    guide: matchedGuide,
                    sceneKind: matchedGuide ? 'gameplay' : 'unknown',
                    actHint: matchedGuide?.act ?? this.getZoneMatchActHint(zoneMatch) ?? this.currentZone.actHint ?? this.runtime.lastGameplayAct ?? null
                };
                if (matchedGuide) {
                    this.runtime.lastGameplayGuideId = matchedGuide.id;
                    this.runtime.lastGameplayZoneRu = matchedGuide.zone_ru;
                    this.runtime.lastGameplayAct = matchedGuide.act;
                    this.runtime.lastValidGameplayZoneAt = nowIso;
                }
                this.syncRuntimeZoneFields(rawSceneSource, matchedGuide);
                this.logZoneEventDecision(zoneMatch, 'updated');
            }
            else if (this.isLoginLikeScene(rawSceneSource)) {
                this.setSceneWithoutGuide(rawSceneSource, 'log', 'login');
                this.logZoneEventDecision(zoneMatch, 'updated');
            }
            else if (this.isUnknownOrNullScene(rawSceneSource) || this.isActLabelScene(rawSceneSource)) {
                this.setSceneWithoutGuide(rawSceneSource, 'log', 'inactive');
                this.logZoneEventDecision(zoneMatch, 'updated');
            }
            else {
                this.setSceneWithoutGuide(rawSceneSource, 'log', 'unknown', this.getZoneMatchActHint(zoneMatch));
                this.logZoneEventDecision(zoneMatch, 'updated');
            }
            return;
        }
        if (this.isTownSceneWithGuide(rawSceneSource, matchedGuide)) {
            this.setTownScene(rawSceneSource ?? 'Город', 'log');
            this.logZoneEventDecision(zoneMatch, 'updated');
            return;
        }
        if (this.isValidGameplaySceneSource(rawSceneSource, matchedGuide)) {
            if (ignoredReason) {
                this.logZoneEventDecision(zoneMatch, 'ignored', ignoredReason);
                return;
            }
            this.runtime.lastValidGameplayZoneAt = nowIso;
            this.setCurrentZone(rawSceneSource ?? '', 'log', matchedGuide, this.getZoneMatchActHint(zoneMatch));
            this.logZoneEventDecision(zoneMatch, 'updated');
            return;
        }
        if (this.isLoginLikeScene(rawSceneSource)) {
            this.setSceneWithoutGuide(rawSceneSource, 'log', 'login');
            this.logZoneEventDecision(zoneMatch, 'updated');
            return;
        }
        if (this.isUnknownOrNullScene(rawSceneSource)) {
            this.setSceneWithoutGuide(rawSceneSource, 'log', 'inactive');
            this.logZoneEventDecision(zoneMatch, 'updated');
            return;
        }
        if (this.isActLabelScene(rawSceneSource)) {
            this.setSceneWithoutGuide(rawSceneSource, 'log', 'inactive');
            this.logZoneEventDecision(zoneMatch, 'updated');
            return;
        }
        this.setSceneWithoutGuide(rawSceneSource, 'log', 'unknown', this.getZoneMatchActHint(zoneMatch));
        this.logZoneEventDecision(zoneMatch, 'updated');
    }
    clearRunTimerStartTimer() {
        if (this.runTimerStartTimer) {
            clearTimeout(this.runTimerStartTimer);
            this.runTimerStartTimer = null;
        }
    }
    persistRunTimer(nextRunTimer) {
        this.config = this.configStore.update({
            runTimer: nextRunTimer
        });
        this.emitRunTimerState();
    }
    scheduleRunTimerAutoStart() {
        this.clearRunTimerStartTimer();
        const { runTimer, runTimerSettings: settings } = this.config;
        if (runTimer.status !== 'armed' ||
            settings.autoStartMode !== 'scheduled_time' ||
            !settings.autoStart ||
            !settings.leagueStartAt) {
            return;
        }
        const delayMs = settings.leagueStartAt - Date.now();
        if (delayMs <= 0) {
            this.startRunTimerFromAnchor(settings.leagueStartAt);
            return;
        }
        this.runTimerStartTimer = setTimeout(() => {
            this.runTimerStartTimer = null;
            this.startRunTimerFromAnchor(settings.leagueStartAt ?? Date.now());
        }, Math.min(delayMs, 2_147_483_647));
    }
    reconcileRunTimerState() {
        this.clearRunTimerStartTimer();
        const { runTimer, runTimerSettings: settings } = this.config;
        if (runTimer.status === 'running' ||
            runTimer.status === 'paused' ||
            runTimer.status === 'finished') {
            return;
        }
        if (!settings.autoStart ||
            settings.autoStartMode !== 'scheduled_time' ||
            !settings.leagueStartAt) {
            if (runTimer.status === 'armed') {
                this.persistRunTimer({
                    ...defaults_1.DEFAULT_RUN_TIMER
                });
            }
            return;
        }
        const now = Date.now();
        if (runTimer.status === 'armed' && now >= settings.leagueStartAt) {
            this.startRunTimerFromAnchor(settings.leagueStartAt);
            return;
        }
        if (settings.leagueStartAt > now) {
            this.armRunTimer(false);
        }
    }
    armRunTimer(shouldBroadcast = true) {
        const settings = this.config.runTimerSettings;
        if (settings.autoStartMode !== 'scheduled_time' ||
            !settings.leagueStartAt) {
            return;
        }
        const now = Date.now();
        if (settings.leagueStartAt <= now) {
            this.startRunTimerFromAnchor(settings.leagueStartAt);
            return;
        }
        this.persistRunTimer({
            ...defaults_1.DEFAULT_RUN_TIMER,
            status: 'armed'
        });
        this.scheduleRunTimerAutoStart();
        this.refreshTrayMenu();
        if (shouldBroadcast) {
            this.broadcastState();
        }
    }
    startRunTimerFromAnchor(startedAt) {
        const now = Date.now();
        this.clearRunTimerStartTimer();
        const nextTownTimer = { ...defaults_1.DEFAULT_TOWN_TIMER };
        this.config = this.configStore.update({
            zoneTimeHistory: [],
            lastRunSummary: null,
            townTimer: nextTownTimer,
            runTimer: {
                status: 'running',
                elapsedMs: Math.max(0, now - startedAt),
                startedAt,
                resumedAt: now,
                pausedAt: null,
                finishedAt: null,
                lastZoneEnteredAt: this.currentZone.sceneKind === 'gameplay' && this.currentZone.guide
                    ? startedAt
                    : null,
                currentZoneElapsedMs: 0,
                currentZoneStartedAt: this.currentZone.sceneKind === 'gameplay' && this.currentZone.guide
                    ? startedAt
                    : null,
                pauseReason: null,
                pauseCount: 0,
                actSplits: []
            }
        });
        this.emitRunTimerState();
        this.refreshTrayMenu();
        this.broadcastState();
    }
    startRunTimerNow() {
        this.startRunTimerFromAnchor(Date.now());
    }
    pauseRunTimer() {
        const runTimer = this.config.runTimer;
        if (runTimer.status !== 'running' || runTimer.resumedAt === null) {
            return;
        }
        const now = Date.now();
        this.persistRunTimer(this.buildManualPausedRunTimer(now));
        this.refreshTrayMenu();
        this.broadcastState();
    }
    resumeRunTimer() {
        const runTimer = this.config.runTimer;
        if (runTimer.status !== 'paused') {
            return;
        }
        const now = Date.now();
        this.persistRunTimer({
            ...runTimer,
            status: 'running',
            resumedAt: now,
            pausedAt: null,
            lastZoneEnteredAt: this.currentZone.sceneKind === 'gameplay' && this.currentZone.guide
                ? now
                : null,
            pauseReason: null
        });
        this.refreshTrayMenu();
        this.broadcastState();
    }
    resetRunTimer() {
        this.clearRunTimerStartTimer();
        const shouldClearPastLeagueStart = typeof this.config.runTimerSettings.leagueStartAt === 'number' &&
            this.config.runTimerSettings.leagueStartAt <= Date.now();
        this.config = this.configStore.update({
            ignoreExistingLogOnNextStart: true,
            runTimer: {
                ...defaults_1.DEFAULT_RUN_TIMER
            },
            townTimer: {
                ...defaults_1.DEFAULT_TOWN_TIMER
            },
            runTimerSettings: {
                ...this.config.runTimerSettings,
                autoStart: false,
                leagueStartAt: shouldClearPastLeagueStart
                    ? null
                    : this.config.runTimerSettings.leagueStartAt,
                leagueStartTimeLabel: shouldClearPastLeagueStart
                    ? null
                    : this.config.runTimerSettings.leagueStartTimeLabel
            },
            zoneTimeHistory: [],
            lastRunSummary: null
        });
        this.emitRunTimerState();
        this.refreshTrayMenu();
        this.broadcastState();
    }
    finishRunTimer() {
        const runTimer = this.config.runTimer;
        if (runTimer.status !== 'running' &&
            runTimer.status !== 'paused') {
            return;
        }
        const now = Date.now();
        this.clearRunTimerStartTimer();
        if (this.config.townTimer.isInTown) {
            this.closeTownVisit(now);
        }
        this.recordZoneTimeEntry(this.currentZone.guide, now);
        const elapsedMs = this.getRunTimerDisplayElapsedMs(now);
        const finalizedActSplits = this.finalizeCurrentActSplit(runTimer, now);
        const nextRunTimer = {
            ...runTimer,
            status: 'finished',
            elapsedMs,
            resumedAt: null,
            pausedAt: runTimer.status === 'paused' ? runTimer.pausedAt : now,
            finishedAt: now,
            lastZoneEnteredAt: null,
            currentZoneElapsedMs: this.getCurrentZoneElapsedMs(now),
            pauseReason: null,
            actSplits: finalizedActSplits
        };
        const previousPb = this.config.bestRun;
        const isNewPb = previousPb === null || elapsedMs < previousPb.totalElapsedMs;
        const nextBestRun = isNewPb
            ? {
                totalElapsedMs: elapsedMs,
                finishedAt: now,
                actSplits: [...nextRunTimer.actSplits]
            }
            : previousPb;
        this.config = this.configStore.update({
            runTimer: nextRunTimer,
            bestRun: nextBestRun,
            lastRunSummary: {
                ...this.buildRunSummary(nextRunTimer, elapsedMs, now),
                isNewPb
            }
        });
        this.emitRunTimerState();
        this.refreshTrayMenu();
        this.broadcastState();
    }
    finalizeCurrentActSplit(runTimer, now) {
        const currentAct = this.currentZone.guide?.act ?? this.currentZone.actHint ?? this.runtime.lastGameplayAct ?? null;
        if (typeof currentAct !== 'number') {
            return [...runTimer.actSplits];
        }
        if (runTimer.actSplits.some((split) => split.act === currentAct)) {
            return [...runTimer.actSplits];
        }
        const highestRecordedAct = [...runTimer.actSplits]
            .sort((left, right) => right.act - left.act)[0]?.act ?? 0;
        if (currentAct < highestRecordedAct) {
            return [...runTimer.actSplits];
        }
        return [
            ...runTimer.actSplits,
            {
                act: currentAct,
                elapsedMs: this.getRunTimerDisplayElapsedMs(now),
                timestamp: now
            }
        ];
    }
    tryRecordActSplitByAct(previousAct, nextAct, now) {
        const runTimer = this.config.runTimer;
        if (runTimer.status !== 'running' ||
            typeof previousAct !== 'number' ||
            typeof nextAct !== 'number' ||
            nextAct === previousAct ||
            nextAct < previousAct ||
            runTimer.actSplits.some((split) => split.act === previousAct)) {
            return null;
        }
        return [
            ...runTimer.actSplits,
            {
                act: previousAct,
                elapsedMs: this.getRunTimerDisplayElapsedMs(now),
                timestamp: now
            }
        ];
    }
    recordActTransitionByHint(previousAct, nextAct, now) {
        const nextSplits = this.tryRecordActSplitByAct(previousAct, nextAct, now);
        if (!nextSplits) {
            return;
        }
        this.persistRunTimer({
            ...this.config.runTimer,
            actSplits: nextSplits
        });
    }
    tryRecordActSplit(previousGuide, nextGuide, now) {
        const runTimer = this.config.runTimer;
        if (runTimer.status !== 'running' ||
            !previousGuide ||
            !nextGuide ||
            typeof previousGuide.act !== 'number' ||
            typeof nextGuide.act !== 'number' ||
            nextGuide.act === previousGuide.act ||
            nextGuide.act < previousGuide.act ||
            runTimer.actSplits.some((split) => split.act === previousGuide.act)) {
            return null;
        }
        return [
            ...runTimer.actSplits,
            {
                act: previousGuide.act,
                elapsedMs: this.getRunTimerDisplayElapsedMs(now),
                timestamp: now
            }
        ];
    }
    handleRunTimerAfterZoneEntered(previousGuide, nextGuide, now) {
        const runTimer = this.config.runTimer;
        this.recordZoneTimeEntry(previousGuide, now);
        const nextSplits = this.tryRecordActSplit(previousGuide, nextGuide, now);
        let shouldPersist = false;
        let nextRunTimer = runTimer;
        if (nextSplits) {
            nextRunTimer = {
                ...nextRunTimer,
                actSplits: nextSplits
            };
            shouldPersist = true;
        }
        if (runTimer.status === 'running') {
            nextRunTimer = {
                ...nextRunTimer,
                lastZoneEnteredAt: now,
                currentZoneElapsedMs: 0
            };
            shouldPersist = true;
        }
        else if (runTimer.currentZoneElapsedMs !== 0 || runTimer.lastZoneEnteredAt !== null) {
            nextRunTimer = {
                ...nextRunTimer,
                currentZoneElapsedMs: 0,
                lastZoneEnteredAt: null
            };
            shouldPersist = true;
        }
        if (shouldPersist) {
            this.persistRunTimer(nextRunTimer);
        }
    }
    processLevelUpFromLogLine(line, source) {
        const parsedLevelUp = (0, log_parser_1.parseLevelUp)(line);
        if (parsedLevelUp === null) {
            return;
        }
        const level = parsedLevelUp.level;
        const previousLevel = this.config.currentLevel;
        const changed = previousLevel !== level;
        if (!changed) {
            return;
        }
        this.config = this.configStore.update({
            currentLevel: level
        });
        this.runtime.lastLevelUpDetectedAt = new Date().toISOString();
        if (source !== 'append') {
            this.broadcastState();
            return;
        }
        const state = this.config.levelRemindersState;
        const reminder = this.guideService.findVendorCheckpointByLevel(level);
        if (!reminder) {
            this.broadcastState();
            return;
        }
        if (state.shown.includes(reminder.id) ||
            state.dismissed.includes(reminder.id)) {
            this.broadcastState();
            return;
        }
        this.config = this.configStore.update({
            levelRemindersState: {
                shown: [...state.shown, reminder.id],
                dismissed: state.dismissed,
                activeLevelReminderId: reminder.id
            }
        });
        this.broadcastState();
    }
    normalizeCampaignBonusSceneName(value) {
        return (0, log_parser_1.normalizeText)(value ?? '');
    }
    getCampaignBonusContextGuideIds() {
        const ids = new Set();
        const currentGuideId = this.currentZone.guide?.id ?? null;
        const lastGameplayGuideId = this.runtime.lastGameplayGuideId ?? null;
        if (this.currentZone.sceneKind === 'town') {
            if (lastGameplayGuideId) {
                ids.add(lastGameplayGuideId);
            }
        }
        else if (currentGuideId) {
            ids.add(currentGuideId);
        }
        if (ids.size === 0 && this.currentZone.sceneKind !== 'town' && lastGameplayGuideId) {
            ids.add(lastGameplayGuideId);
        }
        return ids;
    }
    campaignBonusRuleMatches(rule, line) {
        const normalizedLine = (0, log_parser_1.normalizeText)(line);
        if (rule.all.some((phrase) => !normalizedLine.includes((0, log_parser_1.normalizeText)(phrase)))) {
            return false;
        }
        if (rule.any && rule.any.length > 0) {
            const hasAny = rule.any.some((phrase) => normalizedLine.includes((0, log_parser_1.normalizeText)(phrase)));
            if (!hasAny) {
                return false;
            }
        }
        if (rule.none && rule.none.some((phrase) => normalizedLine.includes((0, log_parser_1.normalizeText)(phrase)))) {
            return false;
        }
        const contextGuideIds = this.getCampaignBonusContextGuideIds();
        if (rule.zoneIds && rule.zoneIds.length > 0) {
            const hasAllowedZone = rule.zoneIds.some((zoneId) => contextGuideIds.has(zoneId));
            if (!hasAllowedZone) {
                return false;
            }
        }
        if (rule.sceneNames && rule.sceneNames.length > 0) {
            const currentScene = this.normalizeCampaignBonusSceneName(this.currentZone.rawZoneName);
            const currentGuideName = this.normalizeCampaignBonusSceneName(this.currentZone.guide?.zone_ru);
            const allowedScenes = rule.sceneNames.map((scene) => this.normalizeCampaignBonusSceneName(scene));
            if (!allowedScenes.includes(currentScene) && !allowedScenes.includes(currentGuideName)) {
                return false;
            }
        }
        return true;
    }
    setCampaignBonusDone(bonusId, detectedBy, line) {
        const existing = this.config.campaignBonusProgress[bonusId];
        const nextProgress = { ...this.config.campaignBonusProgress };
        if (detectedBy === null) {
            if (!existing) {
                return false;
            }
            delete nextProgress[bonusId];
        }
        else {
            nextProgress[bonusId] = {
                state: 'done',
                timestamp: new Date().toISOString(),
                detectedBy,
                ...(line ? { logLine: line } : {})
            };
        }
        const matchedBonus = this.campaignBonuses.find((bonus) => bonus.id === bonusId) ?? null;
        this.config = this.configStore.update({
            campaignBonusProgress: nextProgress
        });
        if (matchedBonus) {
            this.syncCampaignBonusWithChecklist(matchedBonus, detectedBy, line);
        }
        this.broadcastState();
        return true;
    }
    campaignBonusMatchesChecklistItem(bonus, item, normalizedLine) {
        const normalizedTitle = (0, log_parser_1.normalizeText)(bonus.title);
        const normalizedItemText = (0, log_parser_1.normalizeText)(item.text);
        const normalizedSource = (0, log_parser_1.normalizeText)(bonus.source);
        const keywordTexts = item.autoCompleteKeywords.map((keyword) => (0, log_parser_1.normalizeText)(keyword));
        if (normalizedTitle && (normalizedItemText.includes(normalizedTitle) ||
            normalizedTitle.includes(normalizedItemText))) {
            return true;
        }
        if (keywordTexts.some((keyword) => keyword && (normalizedLine.includes(keyword) ||
            normalizedTitle.includes(keyword) ||
            normalizedItemText.includes(keyword) ||
            normalizedSource.includes(keyword)))) {
            return true;
        }
        if (bonus.category === 'resistance' && item.type === 'resistance') {
            const elementWords = ['холод', 'огн', 'молни'];
            return elementWords.some((word) => normalizedTitle.includes(word) && normalizedItemText.includes(word));
        }
        if (bonus.category === 'spirit') {
            return item.type === 'spirit' || normalizedItemText.includes('дух');
        }
        if (bonus.category === 'life') {
            return item.type === 'life' || normalizedItemText.includes('здоров');
        }
        if (bonus.category === 'mana') {
            return item.type === 'mana' || normalizedItemText.includes('ман');
        }
        if (bonus.category === 'weapon_set_passive') {
            return normalizedItemText.includes('пассив') || normalizedItemText.includes('очк');
        }
        return false;
    }
    syncCampaignBonusWithChecklist(bonus, detectedBy, line) {
        if (!bonus.zoneId) {
            return;
        }
        const guide = this.guideService.findById(bonus.zoneId);
        if (!guide?.checklist?.length) {
            return;
        }
        const checklist = (0, checklist_1.buildChecklistDefinition)(guide);
        const normalizedLine = (0, log_parser_1.normalizeText)(line ?? '');
        const directItemIds = new Set();
        for (const item of checklist) {
            if (this.campaignBonusMatchesChecklistItem(bonus, item, normalizedLine)) {
                directItemIds.add(item.id);
            }
        }
        if (directItemIds.size === 0) {
            return;
        }
        const allItemIds = new Set(directItemIds);
        for (const item of checklist) {
            if (item.linkedChecklistItemIds?.some((linkedId) => directItemIds.has(linkedId))) {
                allItemIds.add(item.id);
            }
        }
        const currentProgress = this.config.zoneProgress[guide.id] ?? {
            itemStates: {},
            likelyDoneKeywords: [],
            lastVisitedAt: null
        };
        const nextItemStates = { ...currentProgress.itemStates };
        if (detectedBy === null) {
            for (const itemId of allItemIds) {
                const existing = nextItemStates[itemId];
                if (existing?.detectedBy === 'log' || existing?.detectedBy === 'manual' || existing?.detectedBy === 'linked_reward') {
                    delete nextItemStates[itemId];
                }
            }
        }
        else {
            const timestamp = new Date().toISOString();
            for (const itemId of allItemIds) {
                const item = checklist.find((entry) => entry.id === itemId);
                if (!item) {
                    continue;
                }
                const isLinked = !directItemIds.has(itemId);
                nextItemStates[itemId] = {
                    state: 'done',
                    timestamp,
                    detectedBy: isLinked ? 'linked_reward' : detectedBy,
                    originalText: item.text
                };
            }
        }
        this.config = this.configStore.update({
            zoneProgress: {
                ...this.config.zoneProgress,
                [guide.id]: {
                    ...currentProgress,
                    itemStates: nextItemStates,
                    lastVisitedAt: currentProgress.lastVisitedAt ?? new Date().toISOString()
                }
            }
        });
    }
    campaignBonusTextIncludesAny(bonus, keywords) {
        const searchText = (0, log_parser_1.normalizeText)([bonus.title, bonus.source, ...(bonus.details ?? [])].join(' '));
        return keywords.some((keyword) => {
            const normalizedKeyword = (0, log_parser_1.normalizeText)(keyword);
            return normalizedKeyword ? searchText.includes(normalizedKeyword) : false;
        });
    }
    campaignBonusTextIncludesAll(bonus, keywords) {
        const searchText = (0, log_parser_1.normalizeText)([bonus.title, bonus.source, ...(bonus.details ?? [])].join(' '));
        return keywords.every((keyword) => {
            const normalizedKeyword = (0, log_parser_1.normalizeText)(keyword);
            return normalizedKeyword ? searchText.includes(normalizedKeyword) : false;
        });
    }
    campaignBonusRewardMatchesParsedReward(bonus, reward) {
        if (!reward) {
            return false;
        }
        const value = Number(bonus.reward.value) || 0;
        const amount = reward.amount ?? value;
        const element = (0, log_parser_1.normalizeText)(reward.element ?? reward.matchedKeywords.join(' '));
        switch (reward.rewardKey) {
            case 'passivePoints':
                return false;
            case 'weaponSetPassivePoints':
                return bonus.reward.type === 'weapon_set_passive_points' && value === amount;
            case 'coldResistance10':
                return bonus.reward.type === 'cold_resistance' && value === amount;
            case 'lightningResistance10':
                return bonus.reward.type === 'lightning_resistance' && value === amount;
            case 'fireResistance10':
                return bonus.reward.type === 'fire_resistance' && value === amount;
            case 'resistance5':
                if (element.includes('всем') || element.includes('стих')) {
                    return bonus.reward.type === 'all_elemental_resistance' && value === amount;
                }
                if (element.includes('холод') || element.includes('cold')) {
                    return bonus.reward.type === 'cold_resistance' && value === amount;
                }
                if (element.includes('молн') || element.includes('lightning')) {
                    return bonus.reward.type === 'lightning_resistance' && value === amount;
                }
                if (element.includes('огн') || element.includes('fire')) {
                    return bonus.reward.type === 'fire_resistance' && value === amount;
                }
                return bonus.reward.type === 'all_elemental_resistance' && value === amount;
            case 'spirit30':
            case 'spirit40':
                return bonus.reward.type === 'spirit' && value === amount;
            case 'life20':
                return bonus.reward.type === 'flat_life' && value === amount;
            case 'life5':
                return bonus.reward.type === 'increased_life' && value === amount;
            case 'mana5':
                return bonus.reward.type === 'increased_mana' && value === amount;
            case 'flatMana':
                return bonus.category === 'mana' && value === amount;
            case 'charmSlot':
                return (this.campaignBonusTextIncludesAll(bonus, ['charm', 'slot']) ||
                    this.campaignBonusTextIncludesAll(bonus, ['\u043e\u0431\u0435\u0440\u0435\u0433', '\u044f\u0447\u0435\u0439']));
            case 'charmChargeGain':
                return (this.campaignBonusTextIncludesAny(bonus, ['charm', '\u043e\u0431\u0435\u0440\u0435\u0433']) &&
                    this.campaignBonusTextIncludesAny(bonus, ['charge', 'duration', '\u0437\u0430\u0440\u044f\u0434', '\u0434\u043b\u0438\u0442\u0435\u043b']));
            case 'flaskLifeRecovery':
                return (this.campaignBonusTextIncludesAny(bonus, ['flask', '\u0444\u043b\u0430\u043a\u043e\u043d']) &&
                    this.campaignBonusTextIncludesAny(bonus, ['life recovery', '\u0432\u043e\u0441\u0441\u0442\u0430\u043d\u043e\u0432\u043b', '\u0437\u0434\u043e\u0440\u043e\u0432']));
            case 'stunThreshold':
                return this.campaignBonusTextIncludesAny(bonus, ['stun', '\u043e\u0433\u043b\u0443\u0448']);
            case 'elementalAilmentThreshold':
                return this.campaignBonusTextIncludesAny(bonus, ['elemental ailment', 'ailment', '\u0441\u0442\u0438\u0445\u0438\u0439\u043d', '\u0441\u043e\u0441\u0442\u043e\u044f\u043d']);
            default:
                return false;
        }
    }
    getCampaignBonusRewardFallbackScore(bonus) {
        let score = 0;
        const contextGuideIds = this.getCampaignBonusContextGuideIds();
        const currentAct = this.currentZone.sceneKind === 'town'
            ? (this.runtime.lastGameplayAct ?? this.currentZone.actHint ?? null)
            : (this.currentZone.guide?.act ?? this.currentZone.actHint ?? null);
        const currentScene = this.normalizeCampaignBonusSceneName(this.currentZone.rawZoneName);
        const currentGuideName = this.currentZone.sceneKind === 'town'
            ? ''
            : this.normalizeCampaignBonusSceneName(this.currentZone.guide?.zone_ru);
        const bonusScene = this.normalizeCampaignBonusSceneName(bonus.zone_ru);
        if (contextGuideIds.has(bonus.zoneId)) {
            score += 100;
        }
        if (bonusScene && (bonusScene === currentScene || bonusScene === currentGuideName)) {
            score += 60;
        }
        if (currentAct && bonus.act === currentAct) {
            score += 20;
        }
        if (bonus.needsVerification) {
            score -= 2;
        }
        return score;
    }
    getCampaignBonusRewardFallbackMinScore(parsedReward) {
        switch (parsedReward?.rewardKey) {
            case 'weaponSetPassivePoints':
                // There are several identical +2 weapon-set rewards inside the same act.
                // Mark them only when the current/last gameplay zone points to the exact reward zone.
                return 80;
            case 'spirit30':
            case 'spirit40':
            case 'resistance5':
            case 'coldResistance10':
            case 'lightningResistance10':
            case 'fireResistance10':
            case 'life20':
            case 'life5':
            case 'mana5':
            case 'flatMana':
            case 'charmSlot':
            case 'charmChargeGain':
            case 'flaskLifeRecovery':
            case 'stunThreshold':
            case 'elementalAilmentThreshold':
                // For non-weapon permanent rewards the act context is enough, but a zero-score
                // fallback is too risky: a repeated +30 Spirit line could otherwise tick the next
                // uncompleted +30 Spirit bonus in another act.
                return 20;
            default:
                return 1;
        }
    }
    findCampaignBonusFromParsedReward(line, parsedReward) {
        const reward = parsedReward ?? (0, log_parser_1.parsePermanentReward)(line);
        if (!reward) {
            return null;
        }
        const candidates = this.campaignBonuses
            .map((bonus, index) => ({ bonus, index, score: this.getCampaignBonusRewardFallbackScore(bonus) }))
            .filter(({ bonus }) => !this.config.campaignBonusProgress[bonus.id])
            .filter(({ bonus }) => this.campaignBonusRewardMatchesParsedReward(bonus, reward))
            .sort((left, right) => right.score - left.score || left.index - right.index);
        const best = candidates[0] ?? null;
        if (!best) {
            return null;
        }
        if (best.score < this.getCampaignBonusRewardFallbackMinScore(reward)) {
            return null;
        }
        return best.bonus;
    }
    getCampaignBonusLogLineDedupeKey(line, parsedReward) {
        const normalizedLine = (0, log_parser_1.normalizeText)(line);
        const rewardPart = parsedReward
            ? [parsedReward.rewardKey, parsedReward.amount ?? '', parsedReward.element ?? '', parsedReward.sourceText ?? ''].join('|')
            : normalizedLine;
        return `${rewardPart}|${normalizedLine}`;
    }
    rememberCampaignBonusLogLineKey(key) {
        if (!key) {
            return;
        }
        this.processedCampaignRewardLogLineKeys.add(key);
        this.processedCampaignRewardLogLineOrder.push(key);
        const maxSize = 250;
        while (this.processedCampaignRewardLogLineOrder.length > maxSize) {
            const oldest = this.processedCampaignRewardLogLineOrder.shift();
            if (oldest) {
                this.processedCampaignRewardLogLineKeys.delete(oldest);
            }
        }
    }
    applyCampaignBonusMatchesFromLogLine(line, source) {
        // Old log tail must not resurrect progress after reset. Only live appended
        // lines are allowed to softly tick campaign bonuses.
        if (source !== 'append') {
            return;
        }
        const parsedReward = (0, log_parser_1.parsePermanentReward)(line);
        const dedupeKey = this.getCampaignBonusLogLineDedupeKey(line, parsedReward);
        if (this.processedCampaignRewardLogLineKeys.has(dedupeKey)) {
            return;
        }
        // PoE2 can write two neighbouring lines for one weapon-set reward:
        // 1) generic passive points, 2) weapon-set passive points.
        // The generic line must not complete the next/nearby weapon-set bonus.
        if (parsedReward?.rewardKey === 'passivePoints') {
            this.rememberCampaignBonusLogLineKey(dedupeKey);
            return;
        }
        const matchedByExplicitRule = this.campaignBonuses.find((bonus) => {
            if (this.config.campaignBonusProgress[bonus.id]) {
                return false;
            }
            return bonus.eventRules.some((rule) => this.campaignBonusRuleMatches(rule, line));
        });
        const matchedBonus = matchedByExplicitRule ?? this.findCampaignBonusFromParsedReward(line, parsedReward);
        if (!matchedBonus) {
            return;
        }
        const changed = this.setCampaignBonusDone(matchedBonus.id, 'log', line);
        if (changed) {
            this.rememberCampaignBonusLogLineKey(dedupeKey);
        }
    }
    clearMissedWarning() {
        this.runtime.missedWarningZoneRu = null;
        this.runtime.missedWarningItems = [];
    }
    syncRuntimeZoneFields(rawZoneName, guide) {
        this.runtime.lastRawZoneName = rawZoneName;
        this.runtime.lastMatchedZoneEn = guide?.zone_en ?? null;
        this.runtime.lastMatchedZoneRu = guide?.zone_ru ?? null;
        this.runtime.lastMatchedGuideId = guide?.id ?? null;
    }
    updateZoneProgress(guide) {
        if (!guide) {
            return;
        }
        const currentProgress = this.getZoneProgress(guide.id);
        this.config = this.configStore.update({
            zoneProgress: {
                ...this.config.zoneProgress,
                [guide.id]: {
                    ...currentProgress,
                    lastVisitedAt: new Date().toISOString()
                }
            }
        });
    }
    getZoneProgress(zoneId) {
        return (this.config.zoneProgress[zoneId] ?? {
            itemStates: {},
            likelyDoneKeywords: [],
            lastVisitedAt: null
        });
    }
    mergeLikelyDoneKeywords(guide, matchedKeywords) {
        const currentProgress = this.getZoneProgress(guide.id);
        const mergedKeywords = [
            ...new Set([
                ...currentProgress.likelyDoneKeywords,
                ...matchedKeywords
            ])
        ];
        const hasChanges = mergedKeywords.length !== currentProgress.likelyDoneKeywords.length ||
            mergedKeywords.some((keyword, index) => keyword !== currentProgress.likelyDoneKeywords[index]);
        if (!hasChanges) {
            return false;
        }
        this.config = this.configStore.update({
            zoneProgress: {
                ...this.config.zoneProgress,
                [guide.id]: {
                    ...currentProgress,
                    likelyDoneKeywords: mergedKeywords,
                    lastVisitedAt: currentProgress.lastVisitedAt ?? new Date().toISOString()
                }
            }
        });
        this.broadcastState();
        return true;
    }
    markCurrentChecklistItemDone() {
        // Manual checklist completion disabled. Items are reminders only.
    }
    undoLastChecklistMark() {
        // Manual checklist completion disabled. Nothing to undo.
    }
    setLogStatus(status, message) {
        this.runtime.logWatcherStatus = status;
        this.runtime.logWatcherMessage = message;
        this.scheduleLogFileInfoRefresh();
        this.broadcastState();
    }
    startTimerVisualHeartbeat() {
        this.stopTimerVisualHeartbeat();
        this.timerVisualHeartbeat = setInterval(() => {
            const overlayWindow = this.overlayWindow;
            if (!overlayWindow || overlayWindow.isDestroyed()) {
                return;
            }
            if (overlayWindow.webContents.isDestroyed()) {
                return;
            }
            overlayWindow.webContents.send('timer:visual-tick', {
                now: Date.now()
            });
        }, TIMER_VISUAL_HEARTBEAT_MS);
        if (typeof this.timerVisualHeartbeat?.unref === 'function') {
            this.timerVisualHeartbeat.unref();
        }
    }
    stopTimerVisualHeartbeat() {
        if (!this.timerVisualHeartbeat) {
            return;
        }
        clearInterval(this.timerVisualHeartbeat);
        this.timerVisualHeartbeat = null;
    }
    emitRunTimerState() {
        for (const win of [this.overlayWindow, this.settingsWindow, this.companionWindow, this.infoWindow, this.communityWindow, this.supportWindow]) {
            if (win && !win.isDestroyed()) {
                win.webContents.send('timer:state-changed', this.config.runTimer);
            }
        }
    }
    getSnapshot() {
        const currentGuideEntry = this.currentZone.guide;
        const currentZoneProgress = currentGuideEntry
            ? this.getZoneProgress(currentGuideEntry.id)
            : null;
        return {
            config: this.config,
            currentZone: this.currentZone,
            currentGuideEntry,
            currentZoneProgress,
            currentChecklist: (0, checklist_1.buildChecklistViewItems)(currentGuideEntry, currentZoneProgress ?? undefined),
            guideEntries: this.guideService.getAll(),
            vendorCheckpoints: this.guideService.getVendorCheckpoints(),
            powerSpikes: this.guideService.getPowerSpikes(),
            campaignBonuses: this.campaignBonuses,
            activeLevelReminder: this.getActiveLevelReminder(),
            runtime: {
                ...this.runtime,
                timerNowMs: Date.now()
            }
        };
    }
    clearBroadcastTimer() {
        if (this.broadcastTimer) {
            clearTimeout(this.broadcastTimer);
            this.broadcastTimer = null;
        }
    }
    flushBroadcastState() {
        this.broadcastTimer = null;
        const snapshot = this.pendingSnapshot ?? this.getSnapshot();
        this.pendingSnapshot = null;
        for (const win of [this.overlayWindow, this.settingsWindow, this.companionWindow, this.infoWindow, this.communityWindow, this.supportWindow]) {
            if (win && !win.isDestroyed()) {
                win.webContents.send('app:state-changed', snapshot);
            }
        }
    }
    broadcastState() {
        // Build snapshots lazily in flushBroadcastState(). Creating a full snapshot is
        // relatively expensive (guide lists, checklist view, bonuses). During combat
        // and area loading the log watcher can request several broadcasts in a short
        // burst; doing getSnapshot() for each request was enough to make the overlay
        // feel frozen. The flush always reads the latest app state, so no data is lost.
        this.pendingSnapshot = null;
        if (this.broadcastTimer) {
            return;
        }
        this.broadcastTimer = setTimeout(() => {
            this.flushBroadcastState();
        }, BROADCAST_THROTTLE_MS);
    }
}
const singleInstance = electron_1.app.requestSingleInstanceLock();
if (!singleInstance) {
    electron_1.app.quit();
}
else {
    electron_1.app.whenReady().then(async () => {
        const poeOverlayApp = new PoeOverlayApp();
        await poeOverlayApp.bootstrap();
    });
}
//# sourceMappingURL=main.js.map
