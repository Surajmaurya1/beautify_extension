const themeSelect = document.getElementById('theme');
const toggle = document.getElementById('toggle');
const toggleLabel = document.getElementById('toggleLabel');
const siteEl = document.getElementById('site');
const regenBtn = document.getElementById('regenBtn');
const apiKeyInput = document.getElementById('apiKey');
const saveKeyBtn = document.getElementById('saveKey');
const keyStatus = document.getElementById('keyStatus');

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) =>
      resolve(tabs[0])
    );
  });
}

function flashStatus(text, ms = 2500) {
  keyStatus.textContent = text;
  setTimeout(() => {
    if (keyStatus.textContent === text) keyStatus.textContent = '';
  }, ms);
}

function updateRegenVisibility() {
  regenBtn.style.display = themeSelect.value === 'ai-custom' ? 'block' : 'none';
}

// Load saved API key
chrome.storage.local.get(['bf_api_key'], (data) => {
  if (data.bf_api_key) apiKeyInput.value = data.bf_api_key;
});

saveKeyBtn.addEventListener('click', () => {
  const val = apiKeyInput.value.trim();
  chrome.storage.local.set({ bf_api_key: val }, () => {
    flashStatus(val ? 'Saved ✓' : 'Cleared');
  });
});

(async function init() {
  const tab = await getActiveTab();

  if (!tab || !tab.url || !/^https?:\/\//.test(tab.url)) {
    siteEl.textContent = 'Not available on this page';
    toggle.disabled = true;
    themeSelect.disabled = true;
    regenBtn.style.display = 'none';
    return;
  }

  try {
    siteEl.textContent = new URL(tab.url).hostname;
  } catch (e) {
    siteEl.textContent = tab.url;
  }

  chrome.tabs.sendMessage(tab.id, { type: 'GET_STATE' }, (state) => {
    if (chrome.runtime.lastError || !state) {
      siteEl.textContent += ' (reload the page to activate)';
      toggle.disabled = true;
      themeSelect.disabled = true;
      regenBtn.style.display = 'none';
      return;
    }
    toggle.checked = state.enabled;
    toggleLabel.textContent = state.enabled ? 'On' : 'Off';
    themeSelect.value = state.theme || 'modern-light';
    updateRegenVisibility();
  });

  toggle.addEventListener('change', () => {
    const wantEnabled = toggle.checked;
    toggleLabel.textContent = wantEnabled ? 'On' : 'Off';
    chrome.tabs.sendMessage(
      tab.id,
      { type: 'SET_ENABLED', enabled: wantEnabled },
      (result) => {
        if (result && !result.ok) {
          toggle.checked = false;
          toggleLabel.textContent = 'Off';
          flashStatus(describeError(result.error));
        } else if (result && result.truncated) {
          flashStatus('Applied, but cut off \u2013 try Regenerate');
        }
      }
    );
  });

  themeSelect.addEventListener('change', () => {
    updateRegenVisibility();
    chrome.tabs.sendMessage(
      tab.id,
      { type: 'SET_THEME', theme: themeSelect.value },
      (result) => {
        if (!toggle.checked) {
          toggle.checked = true;
          toggleLabel.textContent = 'On';
        }
        if (result && !result.ok) {
          flashStatus(describeError(result.error));
        } else if (result && result.truncated) {
          flashStatus('Applied, but cut off \u2013 try Regenerate');
        }
      }
    );
  });

  regenBtn.addEventListener('click', () => {
    regenBtn.disabled = true;
    regenBtn.textContent = 'Generating…';
    chrome.tabs.sendMessage(tab.id, { type: 'REGENERATE_AI' }, (result) => {
      regenBtn.disabled = false;
      regenBtn.textContent = '🔄 Regenerate AI Design';
      if (!toggle.checked) {
        toggle.checked = true;
        toggleLabel.textContent = 'On';
      }
      if (!result || !result.ok) {
        flashStatus(describeError(result ? result.error : 'unknown'));
      } else if (result.truncated) {
        flashStatus('Applied, but cut off \u2013 try again');
      } else {
        flashStatus('New design applied ✓');
      }
    });
  });
})();

function describeError(code) {
  switch (code) {
    case 'no_api_key':
      return 'Add your API key above ⬆';
    case 'network_error':
      return 'Network error, try again';
    case 'empty_response':
      return 'AI returned nothing, retry';
    default:
      if (code && String(code).startsWith('blocked_')) return 'Gemini blocked this request';
      if (code && String(code).startsWith('api_error')) return 'AI request failed';
      return 'Something went wrong';
  }
}
