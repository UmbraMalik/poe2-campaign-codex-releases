// Legacy DOM-level localization bridge.
// The app now uses React i18n directly, so this file intentionally stays minimal.
// It only keeps the old global hook safe if an older page still calls it.
declare global {
  interface Window {
    poe2I18nRuntime?: {
      setLanguage: (next: unknown, persist?: boolean) => Promise<'ru' | 'en'>;
      getLanguage: () => 'ru' | 'en';
    };
  }
}

export {};

(function () {
  'use strict';

  type RuntimeLanguage = 'ru' | 'en';

  function resolveLanguage(value: unknown): RuntimeLanguage {
    return value === 'en' ? 'en' : 'ru';
  }

  async function setLanguage(next: unknown, persist = true): Promise<RuntimeLanguage> {
    const language = resolveLanguage(next);
    document.documentElement.lang = language;
    window.localStorage.setItem('poe2-ui-language', language);

    if (persist && window.poe2Overlay?.updateSettings) {
      try {
        await window.poe2Overlay.updateSettings({ appLanguage: language });
      } catch {
        // Older preload builds may not expose appLanguage yet; localStorage still keeps the preference.
      }
    }

    return language;
  }

  window.poe2I18nRuntime = {
    setLanguage,
    getLanguage: () => resolveLanguage(window.localStorage.getItem('poe2-ui-language'))
  };
})();
