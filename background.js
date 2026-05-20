// Service worker — handles icon clicks, context menu, CSS injection, and screenshot capture.

// ── Site detection ────────────────────────────────────────────────────────────
function getSiteName(url) {
  if (!url) return null;
  if (/https?:\/\/[^.]*\.?bbc\.co\.uk/.test(url))   return 'bbc';
  if (/https?:\/\/[^.]*\.?channel5\.com/.test(url)) return 'channel5';
  if (/https?:\/\/[^.]*\.?snooker900\.tv/.test(url)) return 'snooker900';
  if (/https?:\/\/[^.]*\.?youtube\.com/.test(url)) return 'youtube';
  if (/https?:\/\/[^.]*\.?potspot\.net\/.+/.test(url)) return 'potspotdebug';
  return null;
}
function isSanctionedSite(siteName) {
	const unsupported = ['youtube'];
	if (siteName && !unsupported[siteName]) {
		return true;
	}
	return false;
}

// ── Site CSS helpers ──────────────────────────────────────────────────────────
async function injectSiteCSS(tabId, site) {
  if (!site) return;
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: [`site-styles/${site}.css`],
    });
  } catch (e) {}
}

async function removeSiteCSS(tabId, site) {
  if (!site) return;
  try {
    await chrome.scripting.removeCSS({
      target: { tabId },
      files: [`site-styles/${site}.css`],
    });
  } catch (e) {}
}

// ── Context menu ──────────────────────────────────────────────────────────────
// ── UUID helpers ──────────────────────────────────────────────────────────────
// Returns 'YYYY-Qn' for the current calendar quarter, e.g. '2026-Q2'.
function currentQuarterKey() {
  const d = new Date();
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
}

function generateUUID() {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}

// Returns a Promise<string> — the current quarter's UUID.
// Rotates automatically when a new quarter starts.
async function getOrRotateUUID() {
  const data = await chrome.storage.local.get(['statsUUID', 'statsQuarter']);
  const quarter = currentQuarterKey();
  if (data.statsUUID && data.statsQuarter === quarter) {
    return data.statsUUID;
  }
  // New install or new quarter — generate a fresh UUID.
  const uuid = generateUUID();
  await chrome.storage.local.set({ statsUUID: uuid, statsQuarter: quarter });
  return uuid;
}

chrome.runtime.onInstalled.addListener((details) => {
  // Seed the UUID on fresh install (updates keep the existing one via getOrRotateUUID).
  if (details.reason === 'install') {
    chrome.storage.local.set({
      statsUUID:    generateUUID(),
      statsQuarter: currentQuarterKey(),
    });
  }

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'about',
      title: 'About PotSpot',
      contexts: ['action'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'about') {
    chrome.tabs.create({ url: chrome.runtime.getURL('about.html') });
  }
});

// ── Icon click ────────────────────────────────────────────────────────────────
chrome.action.onClicked.addListener(async (tab) => {
  let alreadyInjected = false;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => !!window.__snookerInjected,
    });
    alreadyInjected = result.result;
  } catch (e) {}

  const site = getSiteName(tab.url);

	const SITE_CONFIGS = {
	  snooker900: { 
	  	brightnessThresh: 150, // Highlight detection threshold
	  	brownColour: ''
	  },
	};

  // YouTube: show a non-intrusive overlay and bail — don't load the extension.
  if (site === 'youtube') {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          if (document.getElementById('__potspot_notice')) return;
          const el = document.createElement('div');
          el.id = '__potspot_notice';
          el.style.cssText = [
            'position:fixed', 'top:20px', 'right:20px', 'z-index:2147483647',
            'background:#0f1f0f', 'color:#c8e6c8', 'border:2px solid #1d5c1d',
            'border-radius:8px', 'padding:16px 18px', 'max-width:300px',
            'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif',
            'font-size:13px', 'line-height:1.5', 'box-shadow:-4px 4px 20px rgba(0,0,0,0.6)',
          ].join(';');

          const inner = document.createElement('div');
          inner.style.cssText = 'display:flex;align-items:flex-start;gap:10px';

          const body = document.createElement('div');
          const title = document.createElement('strong');
          title.style.cssText = 'color:#5cb85c;display:block;margin-bottom:6px';
          title.textContent = 'PotSpot';
          body.appendChild(title);
          body.appendChild(document.createTextNode(
            "YouTube isn't currently supported — the video quality is extremely low and ball detection is too unreliable."
          ));

          const closeBtn = document.createElement('button');
          closeBtn.textContent = '✕';
          closeBtn.style.cssText = 'background:none;border:none;color:#5a8a5a;font-size:16px;' +
            'cursor:pointer;flex-shrink:0;padding:0;line-height:1;margin-top:-2px';
          closeBtn.addEventListener('click', () => el.remove());

          inner.appendChild(body);
          inner.appendChild(closeBtn);
          el.appendChild(inner);
          document.body.appendChild(el);
          setTimeout(() => el.remove(), 10000);
        },
      });
    } catch (_) {}
    return;
  }

  if (alreadyInjected) {
    // Toggle panel; __snookerToggle returns true if the panel is now hidden.
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.__snookerToggle?.(),
    });
    const isNowHidden = result?.result;
    if (isNowHidden) {
      await removeSiteCSS(tab.id, site);
    } else {
      await injectSiteCSS(tab.id, site);
    }
    return;
  }

  // Sanctioned sites are BBC iPlayer and Channel 5.
  const sanctioned = isSanctionedSite(site);

  // First injection: set site global (+ unsanctioned flag), inject CSS, then scripts.
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (s, cfg, warn) => {
      window.__potspotSite = s;
      window.__potspotSiteConfig = cfg || {};
      if (warn) window.__potspotWarning = 'unsanctioned';
    },
    args: [site, site == 'potspotdebug' ? SITE_CONFIGS : SITE_CONFIGS[site] || null, !sanctioned],
  });

  await injectSiteCSS(tab.id, site);

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['opencv.js', 'snooker_detect.js', 'injected.js', 'site-controls.js', 'snooker_render.js'],
  });

  // Resolve (and rotate if needed) the UUID once per sidebar load, then cache
  // it in the page context so scan clicks can fire stats without re-checking storage.
  try {
    const uuid = await getOrRotateUUID();
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (u) => { window.__potspotStatsUUID = u; },
      args: [uuid],
    });
    const fd = new FormData();
    fd.append('uuid',   uuid);
    fd.append('action', 'open');
    if (site) fd.append('site', site);
    fetch('https://potspot.net/statsonly/', { method: 'POST', body: fd });
  } catch (_) {}
});

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'capture') {
    chrome.tabs.captureVisibleTab(
      sender.tab.windowId,
      { format: 'jpeg', quality: 100 },
      (dataUrl) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ dataUrl });
        }
      }
    );
    return true; // keep channel open for async response
  }

  if (msg.action === 'submitBug') {
    (async () => {
      try {
        // Screenshot comes from the content script — the service worker's own
        // copy would be lost if the worker was terminated between scan and submit.
        if (!msg.screenshotUrl) {
          sendResponse({ ok: false, error: 'No screenshot available' });
          return;
        }
        const fd = new FormData();
        fd.append('tab_url',      msg.tabUrl);
        fd.append('balls',        msg.balls);
        fd.append('contact',      msg.contact      ?? '');
        fd.append('description',  msg.description  ?? '');
        fd.append('windowWidth',  msg.windowWidth  ?? '');
        fd.append('windowHeight', msg.windowHeight ?? '');

        const screenshotBlob = await fetch(msg.screenshotUrl).then(r => r.blob());
        fd.append('screenshot', screenshotBlob, 'window.jpg');

        // Debug PNG: received as base64 from the content script.
        if (msg.debugBase64) {
          const bin   = atob(msg.debugBase64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          fd.append('debug', new Blob([bytes], { type: 'image/png' }), 'debug.png');
        }

        const resp = await fetch('https://potspot.net/submitbug/', { method: 'POST', body: fd });
        const json = await resp.json();
        sendResponse(json);
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // keep channel open for async response
  }

  if (msg.action === 'sendStats') {
    if (msg.uuid) {
      const fd = new FormData();
      fd.append('uuid',   msg.uuid);
      fd.append('action', msg.eventAction ?? 'scan');
      if (msg.site) fd.append('site', msg.site);
      fetch('https://potspot.net/statsonly/', { method: 'POST', body: fd }).catch(() => {});
    }
    return false;
  }

  if (msg.action === 'removeCSS') {
    chrome.tabs.get(sender.tab.id, (tab) => {
      removeSiteCSS(tab.id, getSiteName(tab.url));
    });
    return false;
  }
});
