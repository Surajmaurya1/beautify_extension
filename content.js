/**
 * Beautify extension - content script
 * - Adds a floating "Beautify" button to every page.
 * - Static themes (modern-light / modern-dark / high-contrast) load a
 *   pre-written CSS file from the extension.
 * - The "ai-custom" theme extracts a structural profile of THIS page
 *   (distinct tag/id/class selectors + existing CSS) and asks Gemini
 *   (via background.js) to write a brand-new CSS redesign using those
 *   exact selectors. The result is cached per-URL so repeat visits don't
 *   re-call the API.
 * - Nothing about the page's ids, classes, markup, or JS is changed -
 *   only a <style> override is added/removed, so functionality never
 *   breaks.
 */
(function () {
  const STYLE_ID = '__beautify_ext_style';
  const CLASS_NAME = '__beautified_by_ext';
  const BTN_ID = '__beautify_ext_fab';
  const DEFAULT_THEME = 'modern-light';

  function hostKey() {
    return 'bf_' + location.hostname;
  }
  function themeKey() {
    return hostKey() + '_theme';
  }
  function aiCacheKey() {
    return 'ai_css_' + location.origin + location.pathname;
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, resolve);
      } catch (e) {
        resolve({});
      }
    });
  }
  function storageSet(obj) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(obj, resolve);
      } catch (e) {
        resolve();
      }
    });
  }

  function getState() {
    return storageGet([hostKey(), themeKey()]).then((data) => ({
      enabled: !!data[hostKey()],
      theme: data[themeKey()] || DEFAULT_THEME,
    }));
  }

  function setState(enabled, theme) {
    return storageSet({ [hostKey()]: enabled, [themeKey()]: theme });
  }

  function applyCss(css) {
    removeTheme();
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
    document.documentElement.classList.add(CLASS_NAME);
  }

  function removeTheme() {
    const existing = document.getElementById(STYLE_ID);
    if (existing) existing.remove();
    document.documentElement.classList.remove(CLASS_NAME);
  }

  /* ---------------- AI redesign ---------------- */

  function buildPageProfile() {
    const MAX_SELECTORS = 250;
    const MAX_CSS_CHARS = 30000;
    const seen = new Set();
    const selectors = [];

    const all = document.querySelectorAll('*');
    for (let i = 0; i < all.length && selectors.length < MAX_SELECTORS; i++) {
      const el = all[i];
      const tag = el.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'link', 'meta', 'svg', 'path'].includes(tag)) continue;
      const id = el.id ? '#' + el.id : '';
      const cls =
        el.classList && el.classList.length
          ? '.' + Array.from(el.classList).join('.')
          : '';
      const sig = tag + id + cls;
      if (seen.has(sig)) continue;
      seen.add(sig);
      selectors.push(sig);
    }

    let cssText = '';
    for (const sheet of Array.from(document.styleSheets)) {
      if (cssText.length > MAX_CSS_CHARS) break;
      try {
        const rules = sheet.cssRules;
        if (!rules) continue;
        for (const rule of Array.from(rules)) {
          cssText += rule.cssText + '\n';
          if (cssText.length > MAX_CSS_CHARS) break;
        }
      } catch (e) {
        // cross-origin stylesheet - can't read, skip it
      }
    }

    let baseline = { background: '', color: '', font: '' };
    try {
      const bs = getComputedStyle(document.body);
      baseline = { background: bs.backgroundColor, color: bs.color, font: bs.fontFamily };
    } catch (e) {}

    return {
      url: location.href,
      title: document.title || location.hostname,
      selectors,
      cssExcerpt: cssText.slice(0, MAX_CSS_CHARS),
      baseline,
      counts: {
        tables: document.querySelectorAll('table').length,
        forms: document.querySelectorAll('form').length,
        images: document.querySelectorAll('img').length,
        links: document.querySelectorAll('a').length,
      },
    };
  }

  function sendToBackground(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (response) => resolve(response));
      } catch (e) {
        resolve({ error: 'message_failed' });
      }
    });
  }

  async function injectAITheme(forceRegenerate) {
    const btn = document.getElementById(BTN_ID);
    if (!forceRegenerate) {
      const cached = await storageGet([aiCacheKey()]);
      const css = cached[aiCacheKey()];
      if (css) {
        applyCss(css);
        return { ok: true, cached: true };
      }
    }

    if (btn) setButtonLoading(btn, true);
    const profile = buildPageProfile();
    const result = await sendToBackground({ type: 'GENERATE_AI_DESIGN', profile });
    if (btn) setButtonLoading(btn, false);

    if (result && result.css) {
      applyCss(result.css);
      await storageSet({ [aiCacheKey()]: result.css });
      return { ok: true, truncated: !!result.truncated };
    }
    return { ok: false, error: (result && result.error) || 'unknown' };
  }

  function setButtonLoading(btn, isLoading) {
    if (isLoading) {
      btn.dataset.loading = 'true';
      btn.textContent = '\u2728 Designing with AI\u2026';
    } else {
      delete btn.dataset.loading;
    }
  }

  function errorMessage(code) {
    switch (code) {
      case 'no_api_key':
        return '\u26A0 Add API key in popup';
      case 'network_error':
        return '\u26A0 Network error';
      case 'empty_response':
        return '\u26A0 AI gave no CSS, retry';
      default:
        if (code && String(code).startsWith('blocked_')) return '\u26A0 AI blocked this request';
        if (code && String(code).startsWith('api_error')) return '\u26A0 AI request failed';
        return '\u26A0 Something went wrong';
    }
  }

  function showButtonMessage(btn, text) {
    const original = btn.textContent;
    const originalActive = btn.getAttribute('data-active');
    btn.textContent = text;
    setTimeout(() => {
      btn.textContent = original;
      btn.setAttribute('data-active', originalActive);
    }, 3000);
  }

  /* ---------------- Theme dispatch (static file OR AI) ---------------- */

  async function injectTheme(theme, forceRegenerate) {
    if (theme === 'ai-custom') {
      return injectAITheme(forceRegenerate);
    }
    const url = chrome.runtime.getURL(`themes/${theme}.css`);
    try {
      const res = await fetch(url);
      const css = await res.text();
      applyCss(css);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'load_failed' };
    }
  }

  /* ---------------- Floating button ---------------- */

  function updateButtonLabel(btn, enabled) {
    btn.textContent = enabled ? '\u21A9 Original Design' : '\u2728 Beautify Page';
    btn.setAttribute('data-active', enabled ? 'true' : 'false');
  }

  function createButton(enabledInitially) {
    if (document.getElementById(BTN_ID)) return;
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    updateButtonLabel(btn, enabledInitially);
    btn.addEventListener('click', onFabClick);
    (document.body || document.documentElement).appendChild(btn);
  }

  async function onFabClick() {
    const btn = document.getElementById(BTN_ID);
    const state = await getState();
    const newEnabled = !state.enabled;

    if (newEnabled) {
      const result = await injectTheme(state.theme);
      if (!result.ok) {
        showButtonMessage(btn, errorMessage(result.error));
        return; // don't persist "enabled" if generation/loading failed
      }
      await setState(newEnabled, state.theme);
      updateButtonLabel(btn, newEnabled);
      if (result.truncated) {
        showButtonMessage(btn, '\u26A0 Design cut off \u2013 Regenerate for full CSS');
      }
      return;
    }
    removeTheme();
    await setState(newEnabled, state.theme);
    updateButtonLabel(btn, newEnabled);
  }

  /* ---------------- Messages from popup ---------------- */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'GET_STATE') {
      getState().then(sendResponse);
      return true;
    }

    if (msg.type === 'SET_ENABLED') {
      (async () => {
        const state = await getState();
        let result = { ok: true };
        if (msg.enabled) {
          result = await injectTheme(state.theme);
        } else {
          removeTheme();
        }
        if (result.ok) await setState(msg.enabled, state.theme);
        const btn = document.getElementById(BTN_ID);
        if (btn) updateButtonLabel(btn, result.ok ? msg.enabled : state.enabled);
        sendResponse(result);
      })();
      return true;
    }

    if (msg.type === 'SET_THEME') {
      (async () => {
        const state = await getState();
        await setState(state.enabled, msg.theme);
        let result = { ok: true };
        if (state.enabled) {
          result = await injectTheme(msg.theme);
        }
        const btn = document.getElementById(BTN_ID);
        if (btn) updateButtonLabel(btn, state.enabled && result.ok);
        sendResponse(result);
      })();
      return true;
    }

    if (msg.type === 'REGENERATE_AI') {
      (async () => {
        const result = await injectTheme('ai-custom', true);
        if (result.ok) await setState(true, 'ai-custom');
        const btn = document.getElementById(BTN_ID);
        if (btn) updateButtonLabel(btn, result.ok);
        sendResponse(result); // includes { ok, truncated? } or { ok:false, error }
      })();
      return true;
    }
  });

  /* ---------------- Init ---------------- */

  async function init() {
    const state = await getState();
    createButton(state.enabled);
    if (state.enabled) {
      await injectTheme(state.theme);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Re-add the button if a page's own script wipes <body> (rare SPA case)
  const observer = new MutationObserver(() => {
    if (!document.getElementById(BTN_ID) && document.body) {
      getState().then((s) => createButton(s.enabled));
    }
  });
  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: false });
  }
})();
