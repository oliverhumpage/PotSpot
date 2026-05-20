// site-controls.js
// Site-specific pause/resume implementations.
// window.__potspotSite is set by background.js before this file is injected.

const __potspotSiteImpl = {
  bbc: {
    pause()  { /* TODO: pause BBC iPlayer stream */ },
    resume() { /* TODO: resume BBC iPlayer stream */ },
  },
  channel5: {
    pause()  { /* TODO: pause Channel 5 stream */ },
    resume() { /* TODO: resume Channel 5 stream */ },
  },
};

// snooker_render.js calls these without needing to know which site it's on.
window.siteControls = {
  pause()  { __potspotSiteImpl[window.__potspotSite]?.pause();  },
  resume() { __potspotSiteImpl[window.__potspotSite]?.resume(); },
};
