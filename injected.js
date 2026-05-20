(function () {
  'use strict';
  if (window.__snookerInjected) { window.__snookerToggle?.(); return; }
  window.__snookerInjected = true;
  // UI, buttons, and chrome messaging are all handled by snooker_render.js.
}());
