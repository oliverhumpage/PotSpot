
// ── Side panel (shadow DOM, right side) ──────────────────────────────────────
const shadowHost = document.createElement('div');
shadowHost.style.cssText = [
  'position:fixed', 'top:0', 'right:0', 'width:380px', 'height:100vh',
  'z-index:2147483646', 'overflow-y:auto',
  'box-shadow:-6px 0 32px rgba(0,0,0,0.55)',
].join(';');
document.body.appendChild(shadowHost);
const shadow = shadowHost.attachShadow({ mode: 'open' });

window.__snookerToggle = function () {
  const wasHidden = shadowHost.style.display === 'none';
  shadowHost.style.display = wasHidden ? '' : 'none';
  if (wasHidden) {
    // Reset to idle state on re-open — old scan result is no longer valid.
    _collapseToIdle();
    clearBalls();
    clearDebugOverlay();
  }
  return !wasHidden; // true = panel is now hidden (caller uses this to remove CSS)
};

// ── Styles ────────────────────────────────────────────────────────────────────
const style = document.createElement('style');
style.textContent = `
  :host { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
  #panel { min-height: 100vh; background: #0f1f0f; display: flex; flex-direction: column;
           border-left: 2px solid #1d5c1d; }
  #panel.compact { min-height: 0; border-bottom: 2px solid #1d5c1d; }
  #header { display: flex; align-items: center; justify-content: space-between;
            padding: 12px 16px; background: #0a1a0a; border-bottom: 1px solid #1d4a1d;
            flex-shrink: 0; }
  #app-name { font-size: 1rem; font-weight: 700; color: #5cb85c; letter-spacing: 1px;
              text-transform: uppercase; }
  #status { font-size: 0.7rem; color: #5a8a5a; line-height: 1.35; margin-top: 4px; }
  #header-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  #debug-btn { display: flex; align-items: center; gap: 5px;
               background: none; border: 1px solid #2a4a2a; border-radius: 5px;
               color: #4a7a4a; font-size: 0.72rem; font-family: inherit;
               padding: 3px 8px; height: 28px; box-sizing: border-box; cursor: pointer;
               white-space: nowrap; transition: border-color 0.15s, color 0.15s; flex-shrink: 0; }
  #debug-btn:hover { border-color: #3a6a3a; color: #6a9a6a; }
  #debug-btn.active { border-color: #b07820; color: #c08830; }
  #debug-led { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
               background: #1a2510; border: 1px solid #2a3a1a;
               transition: background 0.15s, box-shadow 0.15s, border-color 0.15s; }
  #debug-btn.active #debug-led { background: #e08020; border-color: #f0a040;
               box-shadow: 0 0 5px #e08020, 0 0 2px #f0a040; }
  #close-btn { background: none; border: 1px solid #2a4a2a; color: #5a8a5a;
               width: 30px; height: 30px; border-radius: 5px; cursor: pointer;
               font-size: 1rem; line-height: 1; transition: all 0.15s; flex-shrink: 0; }
  #close-btn:hover { background: #1a3a1a; border-color: #3a6a3a; color: #8aba8a; }
  #controls { display: flex; align-items: center; gap: 10px; padding: 10px 16px;
              border-bottom: 1px solid #1a3a1a; flex-shrink: 0; background: #0f1f0f; }
  #controls > button { min-width: 20%; }
  #detect-btn { height: 48px; padding: 0 18px; background: #2d7a2d; color: #fff;
                border: none; border-radius: 6px; font-family: inherit; font-size: 0.88rem;
                font-weight: 600; cursor: pointer; transition: background 0.15s;
                white-space: nowrap; flex-shrink: 0; }
  #detect-btn:hover:not(:disabled) { background: #3a9a3a; }
  #detect-btn:disabled { opacity: 0.45; background-color: #888; cursor: default; }
  #auto-btn { height: 48px; padding: 0 14px; background: #2a62a0; color: #fff;
              border: none; border-radius: 6px; font-family: inherit; font-size: 0.88rem;
              font-weight: 600; cursor: pointer; transition: background 0.15s;
              white-space: nowrap; flex-shrink: 0; display:none;}
  #auto-btn:hover:not(:disabled):not(.cancelling) { background: #3575be; }
  #auto-btn:disabled { opacity: 0.45; cursor: default; }
  #auto-btn.cancelling { background: #1a3d6a; }
  #auto-btn.cancelling:hover { background: #244d82; }
  #hide-btn { height: 48px; padding: 0 14px; background: #383838; color: #bbb;
              border: none; border-radius: 6px; font-family: inherit; font-size: 0.88rem;
              font-weight: 600; cursor: pointer; transition: background 0.15s;
              white-space: nowrap; flex-shrink: 0; }
  #hide-btn:hover:not(:disabled) { background: #484848; }
  #hide-btn:disabled { opacity: 0.45; cursor: default; }
  #toggle-group { display: flex; gap: 4px; margin-left: auto;
                  padding-left: 10px; border-left: 1px solid #1d3a1d; }
  .lp-btn {
    display: flex; align-items: center; justify-content: center;
    width: 44px; height: 48px; padding: 6px;
    background: #181410; border: 1px solid #322a1a; border-radius: 4px;
    color: #504030; cursor: pointer;
    box-shadow: 0 2px 0 #080604, inset 0 1px 0 rgba(255,255,255,0.04),
                inset 0 -1px 4px rgba(0,0,0,0.6);
    transition: background 0.08s, border-color 0.08s, color 0.08s, box-shadow 0.08s;
    user-select: none; flex-shrink: 0;
  }
  .lp-btn svg { width: 20px; height: 20px; flex-shrink: 0; }
  .lp-btn.active {
    background: #b87010; border-color: #d49030; color: #fff5d0;
    box-shadow: 0 1px 0 #080604, 0 0 10px rgba(190,130,10,0.55),
                0 0 3px rgba(210,150,30,0.4),
                inset 0 1px 0 rgba(255,210,80,0.18), inset 0 -1px 3px rgba(0,0,0,0.25);
  }
  .lp-btn:hover:not(.active) { background: #222016; border-color: #443820; color: #706050; }
  .lp-btn:active { transform: translateY(1px);
    box-shadow: 0 0 0 #080604, inset 0 2px 5px rgba(0,0,0,0.7); }
  #table-section { display: none; }
  #tableCanvas { display: block; cursor: crosshair; }
  #panel.capturing { min-height: 0; background: transparent; filter:grayscale(50%); }
  #panel.tableHidden { min-height: 0; background: transparent; border-bottom: 2px solid #1d5c1d; }
  #unsanctioned-banner, #blur-banner { background:#1e1800; border-bottom:1px solid #4a3800;
    padding:10px 14px; font-size:0.72rem; color:#c8b060; line-height:1.5; }
  #unsanctioned-banner a { color:#f0c040; }
  #unsanctioned-banner-close { float:right; background:none; border:none;
    color:#c8b060; font-size:14px; cursor:pointer; padding:0 0 0 8px; line-height:1; }
  #blur-banner { display:none; }
`;
shadow.appendChild(style);

// ── Panel structure ───────────────────────────────────────────────────────────
const _panel = document.createElement('div');
_panel.id = 'panel';
_panel.innerHTML = `
  <div id="header">
    <div>
      <div id="app-name"><img alt="POTSPOT" style="width:100px" src="data:image/svg+xml,%3C%3Fxml%20version%3D%221.0%22%20encoding%3D%22UTF-8%22%20standalone%3D%22no%22%3F%3E%3C!DOCTYPE%20svg%20PUBLIC%20%22-%2F%2FW3C%2F%2FDTD%20SVG%201.1%2F%2FEN%22%20%22http%3A%2F%2Fwww.w3.org%2FGraphics%2FSVG%2F1.1%2FDTD%2Fsvg11.dtd%22%3E%3Csvg%20width%3D%22100%25%22%20height%3D%22100%25%22%20viewBox%3D%220%200%201140%20214%22%20version%3D%221.1%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20xmlns%3Axlink%3D%22http%3A%2F%2Fwww.w3.org%2F1999%2Fxlink%22%20xml%3Aspace%3D%22preserve%22%20xmlns%3Aserif%3D%22http%3A%2F%2Fwww.serif.com%2F%22%20style%3D%22fill-rule%3Aevenodd%3Bclip-rule%3Aevenodd%3Bstroke-linejoin%3Around%3Bstroke-miterlimit%3A2%3B%22%3E%3Cg%20transform%3D%22matrix(1%2C0%2C0%2C1%2C-246%2C10)%22%3E%3Ctext%20x%3D%22239px%22%20y%3D%22191px%22%20style%3D%22font-family%3A'BalooBhaijaan-Regular'%2C%20'Baloo%20Bhaijaan'%2C%20cursive%3Bfont-size%3A306.667px%3Bfill%3Argb(92%2C184%2C92)%3B%22%3EP%3C%2Ftext%3E%3Ctext%20x%3D%22405.213px%22%20y%3D%22191px%22%20style%3D%22font-family%3A'BalooBhaijaan-Regular'%2C%20'Baloo%20Bhaijaan'%2C%20cursive%3Bfont-size%3A266.667px%3Bfill%3Argb(92%2C184%2C92)%3B%22%3EO%3Ctspan%20x%3D%22573.747px%20%22%20y%3D%22191px%20%22%3ET%3C%2Ftspan%3E%3C%2Ftext%3E%3Ctext%20x%3D%22747.613px%22%20y%3D%22191px%22%20style%3D%22font-family%3A'BalooBhaijaan-Regular'%2C%20'Baloo%20Bhaijaan'%2C%20cursive%3Bfont-size%3A306.667px%3Bfill%3Argb(92%2C184%2C92)%3B%22%3ES%3C%2Ftext%3E%3Cg%20transform%3D%22matrix(266.666667%2C0%2C0%2C266.666667%2C1423.413333%2C191)%22%3E%3C%2Fg%3E%3Ctext%20x%3D%22905.547px%22%20y%3D%22191px%22%20style%3D%22font-family%3A'BalooBhaijaan-Regular'%2C%20'Baloo%20Bhaijaan'%2C%20cursive%3Bfont-size%3A266.667px%3Bfill%3Argb(92%2C184%2C92)%3B%22%3EP%3Ctspan%20x%3D%221051.147px%201221.813px%20%22%20y%3D%22191px%20191px%20%22%3EOT%3C%2Ftspan%3E%3C%2Ftext%3E%3C%2Fg%3E%3C%2Fsvg%3E"/></div>
      <div id="status">Loading OpenCV&hellip;</div>
    </div>
    <div id="header-actions">
      <button id="debug-btn" title="Toggle debug overlay"><span id="debug-led"></span>Debug</button>
      <button id="close-btn" title="Close">&#x2715;</button>
    </div>
  </div>
  <div id="controls">
    <button id="detect-btn" title="Scan (P)">Scan</button>
    <button id="auto-btn"  title="Scan (cmd-P)">Auto</button>
    <button id="hide-btn"  title="Hide (H)" disabled>Hide</button>
    <div id="toggle-group">
      <button class="lp-btn" id="submit-btn" title="Submit mis-detection">
        <svg viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
          <polyline points="6.5,5.5 9,2 11.5,5.5" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
          <line x1="9" y1="2" x2="9" y2="10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
          <ellipse cx="9" cy="14" rx="4" ry="3.5" fill="currentColor"/>
          <line x1="5" y1="11.5" x2="2.5" y2="10.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
          <line x1="5" y1="14" x2="2" y2="14" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
          <line x1="5" y1="16.5" x2="2.5" y2="17.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
          <line x1="13" y1="11.5" x2="15.5" y2="10.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
          <line x1="13" y1="14" x2="16" y2="14" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
          <line x1="13" y1="16.5" x2="15.5" y2="17.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
  </div>
  <div id="table-section"></div>
`;
shadow.appendChild(_panel);

const canvas = document.createElement('canvas');
canvas.id = 'tableCanvas';
shadow.getElementById('table-section').appendChild(canvas);

// ── Panel logic ───────────────────────────────────────────────────────────────
function setStatus(msg) { shadow.getElementById('status').textContent = msg; }

// Called by snooker_detect.js once OpenCV has loaded.
function onCvReady() { setStatus('Ready — click Scan.'); }

// ── Blur warning banner (toggled per-scan by _renderResults) ─────────────────
const _blurBanner = document.createElement('div');
_blurBanner.id = 'blur-banner';
_blurBanner.textContent = '⚠ Low quality video — ball detection will be affected';
shadow.getElementById('controls').insertAdjacentElement('afterend', _blurBanner);

// ── Unsanctioned-site notice ──────────────────────────────────────────────────
if (window.__potspotWarning === 'unsanctioned') {
  const banner = document.createElement('div');
  banner.id = 'unsanctioned-banner';
  banner.innerHTML =
    '<button id="unsanctioned-banner-close" title="Dismiss">✕</button>'
    + 'This site has not been tested — if you would like it to be officially supported '
    + 'please get in touch at <a href="https://potspot.net" target="_blank">https://potspot.net</a>';
  shadow.getElementById('controls').insertAdjacentElement('afterend', banner);
  shadow.getElementById('unsanctioned-banner-close').addEventListener('click', () => banner.remove());
}

// ── Debug overlay ─────────────────────────────────────────────────────────────
// A fixed-position canvas drawn over the page (not in the shadow DOM) showing
// table geometry and ball detection internals at image-pixel accuracy.

let _debugCanvas = null;
let _debugResizeListener = null;
let _lastScreenshotUrl = null;
let _lastDebugInfo = null;
let _lastWindowWidth = 0;
let _lastWindowHeight = 0;

function clearDebugOverlay() {
  if (_debugCanvas) {
    _debugCanvas.getContext('2d').clearRect(0, 0, _debugCanvas.width, _debugCanvas.height);
  }
}

// Core drawing logic, shared between the live overlay and the submission PNG export.
function _drawDebugInfo(ctx, info) {
  const s = info.imgWidth / window.innerWidth;
  ctx.save();

  // ── tRect (yellow dashed rect) ─────────────────────────────────────────────
  if (info.tRect) {
    ctx.strokeStyle = 'rgba(255,220,0,0.5)';
    ctx.lineWidth = 1.5 * s;
    ctx.setLineDash([6 * s, 4 * s]);
    const r = info.tRect;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.setLineDash([]);
  }

  if (info.tableLines) {
    const tl = info.tableLines;

    // Frame lines — cyan
    ctx.strokeStyle = 'rgba(0,220,220,0.85)';
    ctx.lineWidth = 2 * s;
    for (const l of tl.frame || []) {
      ctx.beginPath(); ctx.moveTo(l.x1, l.y1); ctx.lineTo(l.x2, l.y2); ctx.stroke();
    }

    // Play-area lines — orange
    ctx.strokeStyle = 'rgba(255,150,0,0.9)';
    for (const l of tl.playArea || []) {
      ctx.beginPath(); ctx.moveTo(l.x1, l.y1); ctx.lineTo(l.x2, l.y2); ctx.stroke();
    }

    // Frame corners — cyan dots
    if (tl.corners) {
      ctx.fillStyle = 'rgba(0,220,220,1)';
      for (const c of [tl.corners.tl, tl.corners.tr, tl.corners.br, tl.corners.bl]) {
        ctx.beginPath(); ctx.arc(c.x, c.y, 4 * s, 0, Math.PI * 2); ctx.fill();
      }
    }

    // Play-area corners — orange dots
    if (tl.playAreaCorners) {
      ctx.fillStyle = 'rgba(255,150,0,1)';
      const pc = tl.playAreaCorners;
      for (const c of [pc.tl, pc.tr, pc.br, pc.bl]) {
        if (c) { ctx.beginPath(); ctx.arc(c.x, c.y, 4 * s, 0, Math.PI * 2); ctx.fill(); }
      }
    }
  }

  // ── Highlights — cyan circles ───────────────────────────────────────────────
  ctx.strokeStyle = 'rgba(0,220,220,0.6)';
  ctx.lineWidth = 1.5 * s;
  for (const h of info.highlights || []) {
    ctx.beginPath();
    ctx.arc(h.hx, h.hy, h.large ? 4 * s : Math.max(h.hr, 3 * s), 0, Math.PI * 2);
    ctx.stroke();
  }

  // ── Arc-scan debug: search rects, edge points, ball-top crosses ────────────
  for (const dbg of info.arcDebug || []) {
    const { rect, edgePts, topX, topY } = dbg;
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = s;
    ctx.setLineDash([3 * s, 3 * s]);
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,140,0,0.85)';
    for (const ep of edgePts || []) ctx.fillRect(ep.x - 1.5 * s, ep.y - 1.5 * s, 3 * s, 3 * s);
    if (topX !== undefined) {
      const arm = 5 * s;
      ctx.strokeStyle = 'rgba(0,255,80,0.9)';
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.moveTo(topX - arm, topY); ctx.lineTo(topX + arm, topY);
      ctx.moveTo(topX, topY - arm); ctx.lineTo(topX, topY + arm);
      ctx.stroke();
    }
  }

  // ── Side-scan debug: rects, edge points, midpoint crosses ─────────────────
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = s;
  ctx.setLineDash([3 * s, 3 * s]);
  for (const dbg of info.sideDebug || []) {
    const { leftRect: lr, rightRect: rr } = dbg;
    if (lr) ctx.strokeRect(lr.x, lr.y, lr.w, lr.h);
    if (rr) ctx.strokeRect(rr.x, rr.y, rr.w, rr.h);
  }
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,140,0,0.85)';
  for (const dbg of info.sideDebug || []) {
    for (const ep of [...(dbg.leftImgPts || []), ...(dbg.rightImgPts || [])])
      ctx.fillRect(ep.x - 1.5 * s, ep.y - 1.5 * s, 3 * s, 3 * s);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1.5 * s;
  for (const dbg of info.sideDebug || []) {
    for (const pt of [dbg.leftEdgePt, dbg.rightEdgePt]) {
      if (!pt) continue;
      const arm = 4 * s;
      ctx.beginPath();
      ctx.moveTo(pt.x - arm, pt.y); ctx.lineTo(pt.x + arm, pt.y);
      ctx.moveTo(pt.x, pt.y - arm); ctx.lineTo(pt.x, pt.y + arm);
      ctx.stroke();
    }
  }

  // ── Detected balls: coloured circle + yellow crosshair + colour initial ────
  function hexRgba(hex, a) {
    const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    return `rgba(${r},${g},${b},${a})`;
  }
  for (const d of info.rawDetections || []) {
    const sw = d.swatch === '#ffffff' ? '#cccccc' :
               d.swatch === '#333333' ? '#aaaaaa' : d.swatch;

    ctx.beginPath();
    ctx.arc(d.cx, d.cy, d.r + 2 * s, 0, Math.PI * 2);
    ctx.setLineDash(d.recovered ? [2 * s, 3 * s] : d.adjusted ? [4 * s, 3 * s] : []);
    ctx.strokeStyle = hexRgba(sw, d.recovered ? 0.6 : d.adjusted ? 0.7 : 1.0);
    ctx.lineWidth = 2.5 * s;
    ctx.stroke();
    ctx.setLineDash([]);

    const tx = d.topX, ty = d.topY;
    const arm = 6 * s;
    ctx.strokeStyle = 'rgba(255,255,0,0.9)';
    ctx.lineWidth = 1.3 * s;
    ctx.beginPath();
    ctx.moveTo(tx - arm, ty); ctx.lineTo(tx + arm, ty);
    ctx.moveTo(tx, ty - arm * 0.8); ctx.lineTo(tx, ty + arm * 0.8);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(tx, ty, 2 * s, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,0,0.9)';
    ctx.fill();

    const lbl = d.name === 'Red' ? 'R' : d.name === '?' ? '?' : d.name[0];
    ctx.font = `bold ${11 * s}px Courier New`;
    ctx.lineWidth = 2.5 * s;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(lbl, d.cx - 4 * s, d.cy + 4 * s);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(lbl, d.cx - 4 * s, d.cy + 4 * s);
  }

  // ── Clear-check contours ────────────────────────────────────────────────────
  for (const c of info.clearCheck?.contours || []) {
    if (c.pts.length < 2) continue;
    const colour = c.cls === 'obstruction' ? 'rgba(255,50,50,0.9)'
                 : c.cls === 'cue'         ? 'rgba(255,160,0,0.9)'
                 :                           'rgba(180,180,180,0.4)';  // 'small' — noise
    ctx.strokeStyle = colour;
    ctx.lineWidth   = (c.cls === 'ball' ? 1.2 : 2.5) * s;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(c.pts[0][0], c.pts[0][1]);
    for (let j = 1; j < c.pts.length; j++) ctx.lineTo(c.pts[j][0], c.pts[j][1]);
    ctx.closePath();
    ctx.stroke();

    // Label obstruction/cue blobs with their classification
    if (c.cls === 'obstruction' || c.cls === 'cue') {
      const lbl = c.cls === 'cue' ? 'CUE' : 'OBS';
      ctx.font        = `bold ${12 * s}px sans-serif`;
      ctx.lineWidth   = 3 * s;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(lbl, c.centroid.x - 15 * s, c.centroid.y);
      ctx.fillStyle   = colour;
      ctx.fillText(lbl, c.centroid.x - 15 * s, c.centroid.y);
    }
  }

  // ── Obstruction expanded+clipped filter zones ─────────────────────────────────
  // Dashed outline shows the dilated+AND-clipped region that was actually used to
  // filter highlights — this is the true exclusion zone, not a bounding rect.
  ctx.strokeStyle = 'rgba(255,80,80,0.75)';
  ctx.lineWidth   = 1.5 * s;
  ctx.setLineDash([4 * s, 3 * s]);
  for (const c of info.obsDebugContours || []) {
    if (c.pts.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(c.pts[0][0], c.pts[0][1]);
    for (let j = 1; j < c.pts.length; j++) ctx.lineTo(c.pts[j][0], c.pts[j][1]);
    ctx.closePath();
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // ── Cue exclusion mask: dark blue bands and filled inter-line regions ─────────
  if (info.cueDebug) {
    ctx.setLineDash([]);
    ctx.lineCap     = 'butt';
    ctx.strokeStyle = 'rgba(20,60,220,0.55)';
    ctx.fillStyle   = 'rgba(20,60,220,0.35)';
    for (const b of info.cueDebug.exclusionBands || []) {
      ctx.lineWidth = Math.max(1, b.halfW * 2 + 1);
      ctx.beginPath(); ctx.moveTo(b.x1, b.y1); ctx.lineTo(b.x2, b.y2); ctx.stroke();
    }
    for (const fill of info.cueDebug.exclusionFills || []) {
      if (fill.length < 3) continue;
      ctx.beginPath();
      ctx.moveTo(fill[0].x, fill[0].y);
      for (let i = 1; i < fill.length; i++) ctx.lineTo(fill[i].x, fill[i].y);
      ctx.closePath();
      ctx.fill();
    }
  }

  ctx.restore();
}

function drawDebugOverlay(info) {
  if (!info) return;

  // Create the overlay canvas once.
  if (!_debugCanvas) {
    _debugCanvas = document.createElement('canvas');
    Object.assign(_debugCanvas.style, {
      position: 'fixed', top: '0', left: '0',
      width: '100vw', height: '100vh',
      pointerEvents: 'none',
      zIndex: '2147483645',
    });
    document.body.appendChild(_debugCanvas);

    // Clear on resize (including browser zoom changes) — captured image
    // coordinates would no longer align with the viewport.
    _debugResizeListener = () => clearDebugOverlay();
    window.addEventListener('resize', _debugResizeListener);
  }

  // Size the canvas to the exact captured image dimensions, then let the CSS
  // (width:100vw; height:100vh) scale it to fit the viewport.  Avoids relying
  // on window.devicePixelRatio, which doesn't reliably include browser zoom.
  _debugCanvas.width  = info.imgWidth;
  _debugCanvas.height = info.imgHeight;

  const ctx = _debugCanvas.getContext('2d');
  ctx.clearRect(0, 0, _debugCanvas.width, _debugCanvas.height);
  _drawDebugInfo(ctx, info);
}

// Renders the debug overlay to an offscreen canvas and returns a PNG Blob.
// The canvas is created, used, and immediately released — no persistent memory.
function _renderDebugToPng(info) {
  if (!info) return Promise.resolve(null);
  const c = document.createElement('canvas');
  c.width  = info.imgWidth;
  c.height = info.imgHeight;
  _drawDebugInfo(c.getContext('2d'), info);
  return new Promise(resolve => c.toBlob(resolve, 'image/png'));
}


shadow.getElementById('close-btn').addEventListener('click', () => {
  shadowHost.style.display = 'none';
  clearDebugOverlay();
  chrome.runtime.sendMessage({ action: 'removeCSS' });
});

shadow.getElementById('debug-btn').addEventListener('click', () => {
  const btn = shadow.getElementById('debug-btn');
  const nowActive = btn.classList.toggle('active');
  if (nowActive && _lastDebugInfo) drawDebugOverlay(_lastDebugInfo);
  else clearDebugOverlay();
});

// ── Scan helpers ──────────────────────────────────────────────────────────────

// ── Submission modal (body level — full-viewport overlay) ────────────────────
// Built at body level rather than inside the shadow DOM so it can cover the
// full viewport and isn't clipped to the 380 px panel width.
const _modalStyle = document.createElement('style');
_modalStyle.textContent = `
  #__ps-modal { position:fixed; inset:0; background:rgba(0,0,0,0.78);
    z-index:2147483647; display:none; align-items:center; justify-content:center;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif; }
  #__ps-modal.open { display:flex; }
  #__ps-modal-box { background:#0f1f0f; border:1px solid #2a5a2a; border-radius:12px;
    padding:24px 28px; width:440px; max-width:calc(100vw - 32px); color:#9aba9a; }
  #__ps-modal h3 { margin:0 0 8px; color:#5cb85c; font-size:1rem; font-weight:700; }
  #__ps-modal .ps-intro { font-size:0.8rem; margin:0 0 6px; }
  #__ps-modal ul { font-size:0.78rem; margin:4px 0 18px; padding-left:18px; line-height:1.6; }
  #__ps-modal .ps-field { margin-bottom:14px; }
  #__ps-modal .ps-field label { display:block; font-size:0.8rem; color:#7aba7a;
    font-weight:600; margin-bottom:4px; }
  #__ps-modal .ps-field .ps-hint { font-size:0.72rem; color:#4a7a4a; margin-top:5px; }
  #__ps-modal textarea, #__ps-modal input[type=text] {
    width:100%; box-sizing:border-box; background:#0a1a0a; border:1px solid #2a5a2a;
    border-radius:5px; color:#c0d0c0; font-size:0.82rem;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
    padding:8px 10px; }
  #__ps-modal textarea { min-height:72px; resize:vertical; }
  #__ps-modal textarea:focus, #__ps-modal input[type=text]:focus
    { outline:none; border-color:#3a8a3a; }
  #__ps-modal .ps-privacy { font-size:0.72rem; color:#4a7a4a; margin:14px 0 0; }
  #__ps-btns { display:flex; gap:8px; justify-content:flex-end; margin-top:18px; }
  #__ps-cancel { background:none; border:1px solid #2a4a2a; color:#6a9a6a;
    border-radius:5px; padding:7px 18px; font-size:0.82rem; cursor:pointer;
    font-family:inherit; }
  #__ps-cancel:hover { background:#1a3a1a; }
  #__ps-send { background:#2d7a2d; border:none; color:#fff; border-radius:5px;
    padding:7px 18px; font-size:0.82rem; font-weight:600; cursor:pointer;
    font-family:inherit; }
  #__ps-send:hover { background:#3a9a3a; }
`;
document.head.appendChild(_modalStyle);

const _submitModal = document.createElement('div');
_submitModal.id = '__ps-modal';
_submitModal.innerHTML = `
  <div id="__ps-modal-box">
    <h3>Submit mis-detection</h3>
    <p class="ps-intro">This will send the following to the developer:</p>
    <ul>
      <li>A screenshot of this page from when you last clicked Scan (just the page content, NOT your tab bar or any other apps)</li>
      <li>This page's URL</li>
      <li>The list of detected ball positions</li>
    </ul>
    <div class="ps-field">
      <label for="__ps-desc">Briefly describe the issue</label>
      <textarea id="__ps-desc" placeholder="eg Missing black ball or Extra green ball etc"></textarea>
    </div>
    <div class="ps-field">
      <label for="__ps-contact">Contact <span style="font-weight:400;color:#4a7a4a">(optional)</span></label>
      <input type="text" id="__ps-contact" placeholder="Email, Twitter handle, etc">
      <p class="ps-hint">Optional. Email/handle/etc — only used to follow up on this report.</p>
    </div>
    <p class="ps-privacy">No other personal data is collected or transmitted.</p>
    <div id="__ps-btns">
      <button id="__ps-cancel">Cancel</button>
      <button id="__ps-send">Send Report</button>
    </div>
  </div>
`;
document.body.appendChild(_submitModal);

document.getElementById('__ps-cancel').addEventListener('click', () => {
  _submitModal.classList.remove('open');
});

document.getElementById('__ps-send').addEventListener('click', async () => {
  _submitModal.classList.remove('open');

  const contact     = document.getElementById('__ps-contact').value.trim();
  const description = document.getElementById('__ps-desc').value.trim();
  if (contact) localStorage.setItem('potspot_contact', contact);

  setStatus('Submitting…');
  try {
    // Render debug PNG in page context (needs canvas), then convert to base64
    // for transfer to the background service worker, which makes the actual fetch.
    let debugBase64 = null;
    const debugBlob = await _renderDebugToPng(_lastDebugInfo);
    if (debugBlob) {
      const buf   = await debugBlob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary  = '';
      const chunk = 8192;
      for (let i = 0; i < bytes.length; i += chunk)
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      debugBase64 = btoa(binary);
    }

    chrome.runtime.sendMessage({
      action:         'submitBug',
      tabUrl:         window.location.href,
      balls:          JSON.stringify(balls),
      contact,
      description,
      debugBase64,
      windowWidth:    _lastWindowWidth,
      windowHeight:   _lastWindowHeight,
      screenshotUrl:  _lastScreenshotUrl,  // pass from content script — background's
                                           // copy is lost if service worker restarted
    }, (result) => {
      if (chrome.runtime.lastError) {
        setStatus('Submission error: ' + chrome.runtime.lastError.message);
        return;
      }
      if (result?.ok) {
        setStatus('Report submitted — thank you!');
      } else {
        setStatus('Submission failed: ' + (result?.error ?? 'Unknown error'));
      }
    });
  } catch (e) {
    setStatus('Submission error: ' + e.message);
  }
});

// Keyboard isolation for the submission modal — two layers needed for pages
// like Channel 5 that attach keydown listeners to window.
//
// Layer 1 — capture on window: swallows keys when focus is outside the modal
// (e.g. a page element still has focus). Runs before any other listener.
//
// Layer 2 — bubble on the modal itself: for keys typed inside the modal
// (textarea, inputs), the event reaches the target normally and the character
// is inserted, but stopPropagation() here prevents it bubbling up to the
// page's window listener which would otherwise call preventDefault().
for (const evType of ['keydown', 'keyup', 'keypress']) {
  window.addEventListener(evType, e => {
    if (!_submitModal.classList.contains('open')) return;
    if (_submitModal.contains(e.target)) return; // handled by layer 2
    e.stopPropagation();
    e.preventDefault();
  }, { capture: true });

  _submitModal.addEventListener(evType, e => {
    e.stopPropagation(); // don't let page listeners preventDefault on our typing
  });
}
shadow.getElementById('submit-btn').addEventListener('click', () => {
  if (!_lastScreenshotUrl) {
    setStatus('Nothing to submit — click Scan Table first.');
    return;
  }
  // Pre-populate contact from localStorage if previously saved.
  const saved = localStorage.getItem('potspot_contact');
  document.getElementById('__ps-contact').value = saved || '';
  document.getElementById('__ps-desc').value = '';
  _submitModal.classList.add('open');
});

// ── Scan helpers ──────────────────────────────────────────────────────────────

let _autoScanActive = false;

function _collapseForScan() {
  shadow.getElementById('table-section').style.display = 'none';
  clearDebugOverlay();
  _panel.classList.add('capturing');
  shadowHost.style.height = 'auto';
  shadowHost.style.overflowY = 'visible';
  shadowHost.style.boxShadow = 'none';
}

function _restorePanel() {
  _panel.classList.remove('capturing');
  shadowHost.style.height = '100vh';
  shadowHost.style.overflowY = 'auto';
  shadowHost.style.boxShadow = '-6px 0 32px rgba(0,0,0,0.55)';
}

// Collapse to the idle/no-table state: compact bar, table hidden, Hide disabled.
// Used on first load, after auto-scan stops without a result, and on scan errors.
function _collapseToIdle() {
  _panel.classList.remove('capturing');
  _panel.classList.remove('tableHidden');
  _panel.classList.add('compact');
  _blurBanner.style.display = 'none';
  shadow.getElementById('table-section').style.display = 'none';
  shadow.getElementById('hide-btn').disabled = true;
  shadow.getElementById('hide-btn').textContent = 'Hide';
  shadowHost.style.height = 'auto';
  shadowHost.style.overflowY = 'auto';
  shadowHost.style.boxShadow = '-6px 0 32px rgba(0,0,0,0.55)';
}

function _setScanBtn(mode) {  // 'scan' | 'disabled'
  const btn = shadow.getElementById('detect-btn');
  btn.disabled = mode === 'disabled';
}

function _setAutoBtn(mode) {  // 'auto' | 'cancel' | 'disabled'
  const btn = shadow.getElementById('auto-btn');
  btn.textContent = mode === 'cancel' ? 'Stop' : 'Auto';
  btn.disabled    = mode === 'disabled';
  btn.classList.toggle('cancelling', mode === 'cancel');
}

// Capture the visible tab and run detection. checkOnly stops before ball scan.
// cb(err, dataUrl, balls, debugInfo)
function _doCapture(checkOnly, cb) {
  function attempt(n) {
    chrome.runtime.sendMessage({ action: 'capture' }, (resp) => {
      if (chrome.runtime.lastError || !resp || resp.error) {
        if (n < 3) { setTimeout(() => attempt(n + 1), 500 * Math.pow(2, n)); return; }
        cb('Capture failed.', null, null, null); return;
      }
      waitForCvThenDetect(resp.dataUrl, window.screen.width, (balls, debugInfo) => {
        cb(null, resp.dataUrl, balls, debugInfo);
      }, true, true, checkOnly);
    });
  }
  attempt(0);
}

// Render a completed (full) scan result into the panel.
function _renderResults(dataUrl, detections, debugInfo) {
  const debugMode = shadow.getElementById('debug-btn').classList.contains('active');
  clearBalls();
  _lastScreenshotUrl = dataUrl;
  _lastDebugInfo     = debugInfo;
  _lastWindowWidth   = window.innerWidth;
  _lastWindowHeight  = window.innerHeight;
  for (const ball of detections) addBall(ball.x, ball.y, ball.colour);
  resolveOverlaps(balls);
  const cc = debugInfo?.clearCheck;
  // Geometry/blur hard failures: collapse to compact bar, no table shown, Hide stays disabled.
  // Obstruction-only failures fall through to the success path — plan view renders with overlay.
  _clearCheckReason = (cc && !cc.suitable && !cc.hasObstruction) ? cc.reason : null;
  _occludedRegions  = debugInfo?.obsRegionsMm || [];

  if (_clearCheckReason) {
    _collapseToIdle();
    setStatus(_clearCheckReason);
  } else {
    _blurBanner.style.display = cc?.blurry ? 'block' : 'none';
    _panel.classList.remove('compact');
    _panel.classList.remove('tableHidden');
    shadowHost.style.height = '100vh';
    shadow.getElementById('table-section').style.display = 'block';
    shadow.getElementById('hide-btn').disabled = false;
    shadow.getElementById('hide-btn').textContent = 'Hide';
    scheduleRender();
    const obsNote = ''; // cc?.hasObstruction ? ' ⚠' : '';
    setStatus(balls.length + ' ball' + (balls.length === 1 ? '' : 's') + ' detected' + obsNote);
  }

  if (debugMode) drawDebugOverlay(debugInfo);
  else clearDebugOverlay();
}

// Extract the play-area ROI (bounding box + trapezoid polygon) from debugInfo.
function _extractROI(info) {
  const pac = info?.tableLines?.playAreaCorners;
  if (pac?.tl && pac?.tr && pac?.bl && pac?.br) {
    const xs = [pac.tl.x, pac.tr.x, pac.bl.x, pac.br.x];
    const ys = [pac.tl.y, pac.tr.y, pac.bl.y, pac.br.y];
    return {
      box:  { x: Math.min(...xs), y: Math.min(...ys),
              x2: Math.max(...xs), y2: Math.max(...ys) },
      poly: [pac.tl, pac.tr, pac.br, pac.bl],
    };
  }
  const r = info?.tRect;
  return r ? { box: { x: r.x, y: r.y, x2: r.x + r.w, y2: r.y + r.h }, poly: null } : null;
}

// Compare the play-area pixel content of two captures at 512×512 resolution.
// Clips to the cushion-nose trapezoid so people around the table are ignored.
// cb(true) if stable (< 0.3 % of pixels changed by more than 20/255 per channel).
function _comparePlayAreas(dataUrl1, roi1, dataUrl2, roi2, cb) {
  const SZ = 512;
  const offscreen = document.createElement('canvas');
  offscreen.width = SZ; offscreen.height = SZ;
  const ctx = offscreen.getContext('2d', { willReadFrequently: true });

  function renderROI(dataUrl, roi, done) {
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, SZ, SZ);
      const { box, poly } = roi;
      const bw = box.x2 - box.x, bh = box.y2 - box.y;
      if (poly && poly.length >= 3) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo((poly[0].x - box.x) * SZ / bw, (poly[0].y - box.y) * SZ / bh);
        for (let i = 1; i < poly.length; i++)
          ctx.lineTo((poly[i].x - box.x) * SZ / bw, (poly[i].y - box.y) * SZ / bh);
        ctx.closePath();
        ctx.clip();
      }
      ctx.drawImage(img, box.x, box.y, bw, bh, 0, 0, SZ, SZ);
      if (poly) ctx.restore();
      done(ctx.getImageData(0, 0, SZ, SZ).data);
    };
    img.src = dataUrl;
  }

  renderROI(dataUrl1, roi1, d1 => {
    renderROI(dataUrl2, roi2, d2 => {
      const PIXEL_THRESH = 20;  // per-channel L∞ distance
      let changed = 0, total = 0;
      for (let i = 0; i < d1.length; i += 4) {
        if (d1[i + 3] === 0 && d2[i + 3] === 0) continue; // both outside polygon
        total++;
        if (Math.abs(d1[i]   - d2[i])   > PIXEL_THRESH ||
            Math.abs(d1[i+1] - d2[i+1]) > PIXEL_THRESH ||
            Math.abs(d1[i+2] - d2[i+2]) > PIXEL_THRESH) changed++;
      }
      cb(total > 0 && changed / total < 0.002);
    });
  });
}

// ── Auto-scan loop ────────────────────────────────────────────────────────────
function _runAutoScan() {
  _autoScanActive = true;
  _setAutoBtn('cancel');
  _setScanBtn('disabled');
  _collapseForScan();

  const startTime = Date.now();
  let prevClear = null; // { dataUrl, roi } of the last suitable frame, or null

  setStatus('Scanning…');

  function _stopAuto() {
    _autoScanActive = false;
    _collapseToIdle();
    _setAutoBtn('auto');
    _setScanBtn('scan');
    setStatus('Ready — click Scan.');
  }

  function loop(immediate) {
    if (!_autoScanActive) { _stopAuto(); return; }
    if (Date.now() - startTime > 30000) {
      _stopAuto();
      setStatus('Cannot find a clear shot of the table.');
      return;
    }

    const scanStart = Date.now();
    _doCapture(true, (err, dataUrl, _balls, debugInfo) => {
      if (!_autoScanActive) { _stopAuto(); return; }
      if (err) { _stopAuto(); setStatus(err); return; }

      const elapsed = Date.now() - scanStart;
      const ccLoop = debugInfo?.clearCheck;
      // Treat obstruction-only as suitable: we'll scan through it.
      // Geometry/blur failures require a clear frame before we can proceed.
      const suitable = ccLoop?.suitable || ccLoop?.hasObstruction;

      if (!suitable) {
        prevClear = null;
        setStatus(ccLoop?.reason || 'Scanning…');
        scheduleNext(elapsed, false);
        return;
      }

      const roi = _extractROI(debugInfo);
      if (!prevClear) {
        prevClear = { dataUrl, roi };
        setStatus('Table clear — verifying…');
        scheduleNext(elapsed, true);
        return;
      }

      // Second+ clear frame — compare pixel content of the play area
      _comparePlayAreas(prevClear.dataUrl, prevClear.roi, dataUrl, roi, (stable) => {
        if (!_autoScanActive) { _stopAuto(); return; }
        if (!stable) {
          prevClear = { dataUrl, roi };
          setStatus('Waiting for balls to settle…');
          scheduleNext(elapsed, false);
          return;
        }
        // Stable clear table — do the full ball-detection scan
        setStatus('Scanning for balls…');
        _doCapture(false, (err2, url2, balls2, debugInfo2) => {
          _stopAuto();
          if (err2) { setStatus(err2); return; }
          _renderResults(url2, balls2, debugInfo2);
        });
      });
    });
  }

  function scheduleNext(elapsed, immediate) {
    setTimeout(loop, immediate ? 0 : Math.max(300 - elapsed, 100));
  }

  // Two rAFs ensure the panel is painted collapsed before the first capture.
  requestAnimationFrame(() => requestAnimationFrame(() => loop(false)));
}

// ── Event handlers ────────────────────────────────────────────────────────────

shadow.getElementById('auto-btn').addEventListener('click', () => {
  if (_autoScanActive) { _autoScanActive = false; return; }
  chrome.runtime.sendMessage({ action: 'sendStats', uuid: window.__potspotStatsUUID, site: window.__potspotSite, eventAction: 'scan' });
  _runAutoScan();
});

shadow.getElementById('detect-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'sendStats', uuid: window.__potspotStatsUUID, site: window.__potspotSite, eventAction: 'scan' });
  // Single scan — disable both scan buttons for the duration.
  _setScanBtn('disabled');
  _setAutoBtn('disabled');
  _collapseForScan();
  setStatus('Capturing…');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    _doCapture(false, (err, url, balls, debugInfo) => {
      _setScanBtn('scan');
      _setAutoBtn('auto');
      if (err) { _collapseToIdle(); setStatus(err); return; }
      _restorePanel();
      _renderResults(url, balls, debugInfo);
    });
  }));
});

shadow.getElementById('hide-btn').addEventListener('click', () => {
  const tableSection = shadow.getElementById('table-section');
  const btn = shadow.getElementById('hide-btn');
  const isHidden = _panel.classList.contains('tableHidden');
  if (isHidden) {
    _panel.classList.remove('tableHidden');
    tableSection.style.display = 'block';
    _restorePanel();
    btn.textContent = 'Hide';
  } else {
    _panel.classList.add('tableHidden');
    tableSection.style.display = 'none';
    shadowHost.style.height = 'auto';
    shadowHost.style.overflowY = 'visible';
    shadowHost.style.boxShadow = 'none';
    btn.textContent = 'Show';
  }
});


// ── Table geometry constants ────────────────────────────────────────────────
// All pixel values are in SVG native pixels (SVG rendered at its natural size).
// Ball positions are in real-world mm with (0,0) at the top-left of the
// playing area (inside of the cushions), D/baulk end at the top.
// x increases rightward (max 1778mm), y increases downward (max 3569mm).

const SVG_W      = 757.5;   // SVG natural width in px
const SVG_H      = 1440;    // SVG natural height in px

const PLAY_X0    = 40;      // SVG px from left edge of SVG to left cushion inside
const PLAY_Y0    = 40;      // SVG px from top edge of SVG to top cushion inside
const PLAY_W_PX  = 677.5;   // SVG px width of playing area
const PLAY_H_PX  = 1360;    // SVG px height of playing area

const PLAY_W_MM  = 1778;    // real-world width of playing area in mm
const PLAY_H_MM  = 3569;    // real-world length of playing area in mm

const BALL_D_MM  = 52.5;    // ball diameter in mm

// Derived: SVG pixels per mm (same in both axes — table is correctly proportioned)
const PX_PER_MM  = PLAY_W_PX / PLAY_W_MM;   // ≈ 0.381
const BALL_R_PX  = (BALL_D_MM / 2) * PX_PER_MM; // ball radius in SVG native px

// ── Pocket geometry (all in mm) ──────────────────────────────────────────────
// Jaw positions mark where each straight cushion ends at a pocket opening.
const JAW_C = 44;                   // corner pocket: jaw distance from each corner
const JAW_M = 51;                   // middle pocket: jaw distance each side of midpoint

// Pocket centre positions in mm (outside the playing area).
// Derived from the SVG pocket-circle positions: each circle is declared in the
// SVG's landscape coordinate space then rotated into portrait screen space, then
// converted from SVG viewBox units → native px → mm via PX_PER_MM.
const POCKET_CTRS = [
  { x: -18,  y: -20   },  // top-left  corner
  { x: 1796, y: -20   },  // top-right corner
  { x: -18,  y: 3585  },  // bot-left  corner
  { x: 1796, y: 3585  },  // bot-right corner
  { x: -45,  y: 1783  },  // left  middle
  { x: 1822, y: 1783  },  // right middle
];


// ── Canvas setup ────────────────────────────────────────────────────────────
const DISP_W  = 380;
const DISP_H  = Math.round(DISP_W * SVG_H / SVG_W);
const DPR     = window.devicePixelRatio || 1;

// CSS size = logical display size; pixel size = DPR× for sharp retina rendering.
canvas.style.width  = DISP_W + 'px';
canvas.style.height = DISP_H + 'px';
canvas.width  = DISP_W * DPR;
canvas.height = DISP_H * DPR;

const S   = DISP_W / SVG_W;   // scale: SVG native px → CSS px (drawing coords)
const ctx = canvas.getContext('2d');
ctx.scale(DPR, DPR);           // all drawing ops now work in CSS px

// Radius of the SVG pocket circles in canvas px (r=1.55 viewBox units).
const POCKET_R = 1.55 * (SVG_W / 75.779997) * S;



// ── Ball data ────────────────────────────────────────────────────────────────
// Positions in real-world mm from top-left of playing area (baulk/D end).
// Populated at runtime via addBall() / clearBalls().
let balls = [];
let _clearCheckReason  = null;
let _occludedRegions   = [];   // obsRegionsMm entries from last scan, for plan-view shading

// ── Overlap resolution ───────────────────────────────────────────────────────
// Pre-cull: remove balls >40% outside a side cushion (left/right wall only).
// Phase 1: snap remaining balls to cushion, skipping pocket jaw openings.
// Phase 2: iteratively find the most-overlapping ball pair and push them apart
// in Y only, respecting cushion bounds (overflow transfers to the other ball).
// Reverts phase-2 moves if: >30 iterations still leave overlaps, or total
// phase-2 movement exceeds one ball diameter.
function resolveOverlaps(balls) {
  const R        = BALL_D_MM / 2;
  const DIAM     = BALL_D_MM;
  const DIAM_SQ  = DIAM * DIAM;
  const MAX_ITER = 30;

  // Fraction of ball area that lies outside a wall whose inside face is at
  // distance d from the ball centre (d > 0 = centre inside, d ≤ 0 = outside).
  const capFrac = (d) => {
    if (d >= R)  return 0;
    if (d <= -R) return 1;
    return (R * R * Math.acos(d / R) - d * Math.sqrt(R * R - d * d)) / (Math.PI * R * R);
  };

  // Pre-cull — side cushion overlap > 40 % of ball area.
  // Catches false detections from the top-pocket linings, which sit well outside
  // the playing area in x.  Area check (not just offset) means a ball genuinely
  // in a corner-pocket jaw — partially outside x but with most of its area still
  // over the table — is preserved.  Top/bottom walls are intentionally excluded:
  // pocket-jaw balls there can legitimately sit at y < R.
  for (let i = balls.length - 1; i >= 0; i--) {
    const b = balls[i];
    if (capFrac(b.x) > 0.4 || capFrac(PLAY_W_MM - b.x) > 0.4) balls.splice(i, 1);
  }

  // Phase 1 — cushion snap with pocket-jaw awareness.
  // Skip the snap for each wall when the ball's position projects onto a pocket
  // opening on that wall, matching the JAW geometry used by findBoundaryHit.
  const MID = PLAY_H_MM / 2;
  for (const b of balls) {
    // Left / right cushions: pocket openings are at corners and middle (y-zones).
    const inSideJawY = b.y < JAW_C || b.y > PLAY_H_MM - JAW_C ||
                       (b.y >= MID - JAW_M && b.y <= MID + JAW_M);
    if (!inSideJawY) b.x = Math.max(R, Math.min(PLAY_W_MM - R, b.x));

    // Top / bottom cushions: pocket openings are at corners only (x-zones).
    const inTopBotJawX = b.x < JAW_C || b.x > PLAY_W_MM - JAW_C;
    if (!inTopBotJawX) b.y = Math.max(R, Math.min(PLAY_H_MM - R, b.y));
  }

  // Phase 2 — ball-ball separation (Y only)
  const saved = balls.map(b => ({ x: b.x, y: b.y }));
  let totalMove = 0;
  let solved    = false;
  let reverted  = false;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    // Find the most-overlapping pair (largest overlap distance)
    let worstOv = 0, wi = -1, wj = -1;
    for (let i = 0; i < balls.length; i++) {
      for (let j = i + 1; j < balls.length; j++) {
        const dx = balls[i].x - balls[j].x;
        const dy = balls[i].y - balls[j].y;
        const ov = DIAM - Math.sqrt(dx * dx + dy * dy);
        if (ov > worstOv) { worstOv = ov; wi = i; wj = j; }
      }
    }
    if (wi < 0) { solved = true; break; }

    const bi = balls[wi], bj = balls[wj];
    const dy = bi.y - bj.y;
    // 'down' moves in +Y, 'up' moves in −Y
    const down = dy >= 0 ? bi : bj;
    const up   = dy >= 0 ? bj : bi;

    const dx    = bi.x - bj.x;
    const reqDy = Math.sqrt(DIAM_SQ - dx * dx);  // required Y separation
    const total = reqDy - Math.abs(dy);           // total Y to add

    if (total <= 0.01) { solved = true; break; }  // floating-point residual

    // Split equally; if one ball is cushion-constrained, transfer remainder
    const half     = total / 2;
    const moveDown = Math.min(half, PLAY_H_MM - R - down.y);
    const moveUp   = Math.min(half + (half - moveDown), up.y - R);

    down.y    += moveDown;
    up.y      -= moveUp;
    totalMove += moveDown + moveUp;

    if (totalMove > DIAM) {
      balls.forEach((b, k) => { b.x = saved[k].x; b.y = saved[k].y; });
      reverted = true;
      break;
    }
  }

  // Ran out of iterations with overlaps still present — revert
  if (!solved && !reverted) {
    balls.forEach((b, k) => { b.x = saved[k].x; b.y = saved[k].y; });
  }
}

function addBall(x_mm, y_mm, colour) {
  balls.push({ x: x_mm, y: y_mm, colour });
}

function clearBalls() {
  balls              = [];
  _lastScreenshotUrl = null;
  _lastDebugInfo     = null;
  _clearCheckReason  = null;
  _occludedRegions   = [];
  selectedBall       = null;
  _objTarget         = null;
  _objDisplay        = null;
  _pocketSnap        = null;
}


// ── Coordinate conversion ───────────────────────────────────────────────────
function mmToCanvas(x_mm, y_mm) {
  return {
    x: (PLAY_X0 + x_mm * PX_PER_MM) * S,
    y: (PLAY_Y0 + y_mm * PX_PER_MM) * S,
  };
}

function canvasToMm(cx, cy) {
  return {
    x: (cx / S - PLAY_X0) / PX_PER_MM,
    y: (cy / S - PLAY_Y0) / PX_PER_MM,
  };
}

// Map a mouse event to CSS-pixel canvas coordinates.
// The context is already scaled by DPR so drawing uses CSS px throughout.
function eventToCanvas(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (rect.width  > 0 ? DISP_W / rect.width  : 1),
    y: (e.clientY - rect.top)  * (rect.height > 0 ? DISP_H / rect.height : 1),
  };
}


// ── Hit test ─────────────────────────────────────────────────────────────────
// Returns the index of the ball under canvas point (cx, cy), or null.
function ballAt(cx, cy) {
  const R = BALL_R_PX * S;
  for (let i = 0; i < balls.length; i++) {
    const c = mmToCanvas(balls[i].x, balls[i].y);
    const dx = cx - c.x, dy = cy - c.y;
    if (dx * dx + dy * dy <= R * R) return i;
  }
  return null;
}


// ── Collision detection ──────────────────────────────────────────────────────
// Sweeps a ball (radius = BALL_D_MM/2) from (px,py) along unit direction
// (dx,dy) — all in mm — and returns the nearest {t, ballIdx} collision, or null.
// excludeIdx: the moving ball's own index (skipped in the search).
function findCollision(px, py, dx, dy, excludeIdx) {
  const twoR = BALL_D_MM;           // sum of two radii
  const twoR2 = twoR * twoR;
  let best = null;

  for (let i = 0; i < balls.length; i++) {
    if (i === excludeIdx) continue;
    // w = cue-ball-centre − other-ball-centre
    const wx = px - balls[i].x, wy = py - balls[i].y;
    const wDotD  = wx * dx + wy * dy;
    const perpSq = wx * wx + wy * wy - wDotD * wDotD;
    if (perpSq >= twoR2) continue;             // misses
    const t = -wDotD - Math.sqrt(twoR2 - perpSq);
    if (t < 0) continue;                       // collision is behind start
    if (best === null || t < best.t) best = { t, ballIdx: i };
  }
  return best;
}


// ── Boundary / cushion hit ───────────────────────────────────────────────────
// Returns { t, hitX, hitY, pocket } for the first playing-area boundary the ray
// (from px,py in direction dx,dy — all mm) crosses.  pocket is a POCKET_CTRS
// entry when the crossing is inside a pocket opening, otherwise null (cushion).
function findBoundaryHit(px, py, dx, dy) {
  let best = null;

  function consider(t, hitX, hitY, pocketIdx) {
    if (t > 1e-6 && (best === null || t < best.t))
      best = { t, hitX, hitY, pocket: pocketIdx >= 0 ? POCKET_CTRS[pocketIdx] : null };
  }

  const MID = PLAY_H_MM / 2;

  // Top wall  y = 0  (only reachable when dy < 0)
  if (dy < 0) {
    const t = -py / dy, hx = px + t * dx;
    if (hx >= 0 && hx <= PLAY_W_MM)
      consider(t, hx, 0,
        hx < JAW_C               ? 0   // TL pocket
      : hx > PLAY_W_MM - JAW_C   ? 1   // TR pocket
      : -1);                           // cushion
  }

  // Bottom wall  y = PLAY_H_MM  (dy > 0)
  if (dy > 0) {
    const t = (PLAY_H_MM - py) / dy, hx = px + t * dx;
    if (hx >= 0 && hx <= PLAY_W_MM)
      consider(t, hx, PLAY_H_MM,
        hx < JAW_C               ? 2   // BL pocket
      : hx > PLAY_W_MM - JAW_C   ? 3   // BR pocket
      : -1);
  }

  // Left wall  x = 0  (dx < 0)
  if (dx < 0) {
    const t = -px / dx, hy = py + t * dy;
    if (hy >= 0 && hy <= PLAY_H_MM)
      consider(t, 0, hy,
        hy < JAW_C                          ? 0   // TL pocket
      : hy > PLAY_H_MM - JAW_C              ? 2   // BL pocket
      : hy >= MID - JAW_M && hy <= MID + JAW_M ? 4  // left middle
      : -1);
  }

  // Right wall  x = PLAY_W_MM  (dx > 0)
  if (dx > 0) {
    const t = (PLAY_W_MM - px) / dx, hy = py + t * dy;
    if (hy >= 0 && hy <= PLAY_H_MM)
      consider(t, PLAY_W_MM, hy,
        hy < JAW_C                          ? 1   // TR pocket
      : hy > PLAY_H_MM - JAW_C              ? 3   // BR pocket
      : hy >= MID - JAW_M && hy <= MID + JAW_M ? 5  // right middle
      : -1);
  }

  return best;
}


// ── Interaction state ────────────────────────────────────────────────────────
let selectedBall = null;
let mousePos     = { x: 0, y: 0 };

// ── Object-ball direction smoothing ─────────────────────────────────────────
// The deflection angle is amplified by (cue–object distance) / BALL_D_MM
// relative to the aim angle.  For a 2000mm shot that's ~38×, so a single
// 1-px cursor step causes a large swing in the deflection line.  We smooth
// using an EMA in a RAF loop so the display converges smoothly even after
// the mouse stops.
let _objTarget  = null;   // raw unit vec from the current aim
let _objDisplay = null;   // smoothed unit vec (EMA toward _objTarget)
let _pocketSnap = null;   // { dir:{x,y} } while display is held at a pocket, else null
let _rafPending = false;

const OBJ_SMOOTH = 0.25;   // fraction of gap closed per frame (~5 frames → 97%)

function scheduleRender() {
  if (!_rafPending) {
    _rafPending = true;
    requestAnimationFrame(renderFrame);
  }
}

function renderFrame() {
  _rafPending = false;
  if (_objTarget && _objDisplay) {
    const ex = _objTarget.x - _objDisplay.x;
    const ey = _objTarget.y - _objDisplay.y;
    if (ex * ex + ey * ey > 1e-8) {
      _objDisplay.x += OBJ_SMOOTH * ex;
      _objDisplay.y += OBJ_SMOOTH * ey;
      const m = Math.hypot(_objDisplay.x, _objDisplay.y);
      _objDisplay.x /= m;
      _objDisplay.y /= m;
      scheduleRender();  // keep animating until converged
    }
  }
  drawScene();
}


// ── Drawing ───────────────────────────────────────────────────────────────────
function placeBall(ball, highlight) {
  const r = BALL_R_PX * S;
  const { x, y } = mmToCanvas(ball.x, ball.y);

  // Drop shadow
  ctx.save();
  ctx.shadowColor   = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur    = r * 0.8;
  ctx.shadowOffsetX = r * 0.18;
  ctx.shadowOffsetY = r * 0.18;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = ball.colour;
  ctx.fill();
  ctx.restore();

  // Specular highlight gradient
  const grad = ctx.createRadialGradient(
    x - r * 0.32, y - r * 0.32, r * 0.05,
    x, y, r
  );
  grad.addColorStop(0,   'rgba(255,255,255,0.55)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.08)');
  grad.addColorStop(1,   'rgba(0,0,0,0.15)');
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  // Selection ring
  if (highlight) {
    ctx.beginPath();
    ctx.arc(x, y, r + 1.5 * S, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth   = 1 * S;
    ctx.stroke();
  }
}

// Draw a line from startMm in unit direction (dx,dy).
// excludeIdx: ball index to skip in collision checks (the ball that's moving).
// tMax:       furthest t to draw to when no obstacle is hit (use Infinity for
//             object-ball lines that should always reach the first obstacle).
// colour:     CSS stroke colour.
// Returns { collision } so the caller can chain a follow-up line.
function shootLine(startMm, dx, dy, excludeIdx, tMax, colour) {
  const collision = findCollision(startMm.x, startMm.y, dx, dy, excludeIdx);
  const boundary  = findBoundaryHit(startMm.x, startMm.y, dx, dy);
  const tBound    = boundary ? boundary.t : Infinity;
  const tHit      = (collision && collision.t < tBound) ? collision.t : Infinity;

  let endMm, pocketHit = null;
  if (tHit < Infinity && tHit <= tMax) {
    // Ball in the way before tMax — stop at the collision point
    endMm = { x: startMm.x + tHit * dx, y: startMm.y + tHit * dy };
  } else if (boundary && boundary.t <= tMax) {
    // Wall or pocket jaw — always stop at the wall face (continuous endpoint),
    // but record the pocket so the caller can light it up separately.
    endMm = { x: boundary.hitX, y: boundary.hitY };
    if (boundary.pocket) pocketHit = boundary.pocket;
  } else {
    // Nothing in the way before tMax (cursor position)
    endMm = { x: startMm.x + tMax * dx, y: startMm.y + tMax * dy };
  }

  const startC = mmToCanvas(startMm.x, startMm.y);
  const endC   = mmToCanvas(endMm.x,   endMm.y);
  const lineW  = (BALL_D_MM / 4) * PX_PER_MM * S;

  ctx.save();
  ctx.globalAlpha = 0.72;
  ctx.beginPath();
  ctx.moveTo(startC.x, startC.y);
  ctx.lineTo(endC.x,   endC.y);
  ctx.strokeStyle = colour;
  ctx.lineWidth   = lineW;
  ctx.lineCap     = 'round';
  ctx.stroke();
  ctx.restore();

  // Only report a collision if it's within range (not past tMax)
  return { collision: (tHit < Infinity && tHit <= tMax) ? collision : null, pocket: pocketHit };
}

function drawLitPocket(pocket, colour) {
  const c = mmToCanvas(pocket.x, pocket.y);
  ctx.save();
  ctx.beginPath();
  ctx.arc(c.x, c.y, POCKET_R, 0, Math.PI * 2);
  ctx.fillStyle = colour;
  ctx.globalAlpha = 0.85;
  ctx.fill();
  ctx.restore();
}

function drawShotLine() {
  if (selectedBall === null) return;

  const ball    = balls[selectedBall];
  const isWhite = ball.colour === '#f5f0dc';
  const mouseMm = canvasToMm(mousePos.x, mousePos.y);
  const dirX = mouseMm.x - ball.x, dirY = mouseMm.y - ball.y;
  const len  = Math.hypot(dirX, dirY);
  if (len < 1) return;
  const dx = dirX / len, dy = dirY / len;

  const lineColour = isWhite ? 'rgba(255,255,255,0.95)' : ball.colour;

  // Non-white: extend past cursor only if the direction leads to a pocket.
  // White: always truncate at cursor (deflection line handles the rest).
  let tMax = len;
  if (!isWhite) {
    const boundary = findBoundaryHit(ball.x, ball.y, dx, dy);
    if (boundary && boundary.pocket) tMax = Infinity;
  }

  // Ball line — stops at first ball, pocket, or cursor (whichever comes first)
  const { collision, pocket: cuePocket } = shootLine(
    { x: ball.x, y: ball.y }, dx, dy, selectedBall, tMax, lineColour
  );

  // Object-ball deflection — only for the white/cue ball
  let objPocket = null, objColour = null;
  if (isWhite && collision) {
    const ghostX  = ball.x + collision.t * dx;
    const ghostY  = ball.y + collision.t * dy;
    const objBall = balls[collision.ballIdx];
    objColour = objBall.colour;

    // Object ball travels along the centre-to-centre line at impact
    const odx0 = objBall.x - ghostX, ody0 = objBall.y - ghostY;
    const olen  = Math.hypot(odx0, ody0);
    if (olen > 0.1) {
      const rawX = odx0 / olen, rawY = ody0 / olen;
      // Hard-reset if no prior direction or direction has reversed (>90°)
      if (!_objDisplay || _objDisplay.x * rawX + _objDisplay.y * rawY < 0) {
        _objDisplay = { x: rawX, y: rawY };
        _pocketSnap = null;
      }
      _objTarget = { x: rawX, y: rawY };

      // ── Pocket-snap logic ────────────────────────────────────────────────
      // "Real" line = computed from cursor (_objTarget / rawX,rawY).
      // "Display" line = smoothed EMA (_objDisplay), possibly lagging.
      // Rule: if the display sweeps through a pocket the real aim isn't
      // targeting, hold the display at that pocket direction until the real
      // aim diverges far enough away to make the snap meaningless.
      const SNAP_RELEASE = Math.cos(15 * Math.PI / 180);
      const tgtB = findBoundaryHit(objBall.x, objBall.y, rawX, rawY);
      const dspB = findBoundaryHit(objBall.x, objBall.y, _objDisplay.x, _objDisplay.y);

      if (tgtB && tgtB.pocket) {
        // Real aim already at a pocket — let EMA converge naturally, no snap
        _pocketSnap = null;
      } else if (dspB && dspB.pocket) {
        // EMA display is passing through a pocket the real aim isn't targeting
        _pocketSnap = { dir: { x: _objDisplay.x, y: _objDisplay.y } };
      } else if (_pocketSnap) {
        // Snap held from previous frame — release if real aim has diverged >15°
        if (rawX * _pocketSnap.dir.x + rawY * _pocketSnap.dir.y < SNAP_RELEASE) {
          _pocketSnap = null;
        }
      }

      // Render with snapped direction when active; otherwise use smoothed EMA
      const renderX = _pocketSnap ? _pocketSnap.dir.x : _objDisplay.x;
      const renderY = _pocketSnap ? _pocketSnap.dir.y : _objDisplay.y;

      ({ pocket: objPocket } = shootLine(
        { x: objBall.x, y: objBall.y },
        renderX, renderY,
        collision.ballIdx,
        Infinity,
        objBall.colour
      ));
    }
  } else {
    // No collision — clear all state so next contact starts fresh
    _objTarget  = null;
    _objDisplay = null;
    _pocketSnap = null;
  }

  // Light up any pockets the lines entered
  if (cuePocket) drawLitPocket(cuePocket, lineColour);
  if (objPocket) drawLitPocket(objPocket, objColour);
}

function drawScene() {
  ctx.clearRect(0, 0, DISP_W, DISP_H);

  if (_clearCheckReason) {
    ctx.fillStyle = '#0f1f0f';
    ctx.fillRect(0, 0, DISP_W, DISP_H);
    ctx.fillStyle = '#e87878';
    ctx.font = 'bold 15px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(_clearCheckReason, DISP_W / 2, 36);
    ctx.textAlign = 'left';
    return;
  }

  ctx.drawImage(svgImg, 0, 0, DISP_W, DISP_H);

  // Occlusion overlays: semi-transparent dark fill over table regions where an
  // obstruction was detected.  Points are already in table mm from the detector.
  if (_occludedRegions.length > 0) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    for (const region of _occludedRegions) {
      if (!region.ptsMm || region.ptsMm.length < 2) continue;
      ctx.beginPath();
      const first = mmToCanvas(region.ptsMm[0].x, region.ptsMm[0].y);
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < region.ptsMm.length; i++) {
        const p = mmToCanvas(region.ptsMm[i].x, region.ptsMm[i].y);
        ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  for (let i = 0; i < balls.length; i++) {
    placeBall(balls[i], i === selectedBall);
  }

  drawShotLine();
}


// ── Event handlers ───────────────────────────────────────────────────────────
canvas.addEventListener('click', e => {
  const { x, y } = eventToCanvas(e);

  if (selectedBall !== null) {
    selectedBall = null;
    _objTarget   = null;
    _objDisplay  = null;
    _pocketSnap  = null;
    scheduleRender();
    return;
  }

  const hit = ballAt(x, y);
  if (hit !== null) {
    selectedBall = hit;
    mousePos     = { x, y };
    scheduleRender();
  }
});

canvas.addEventListener('mousemove', e => {
  if (selectedBall === null) return;
  mousePos = eventToCanvas(e);
  scheduleRender();
});


// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (shadowHost.style.display === 'none') return; // panel closed

  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return; // don't steal from text fields

  const isMod = e.metaKey || e.ctrlKey;

  if (e.key === 'Escape') {
    if (_autoScanActive) {
      _autoScanActive = false;           // cancels auto-scan loop
    } else if (selectedBall !== null) {
      selectedBall = null;
      _objTarget = null; _objDisplay = null; _pocketSnap = null;
      scheduleRender();
    }
    return;
  }

  if (e.key === 'p' || e.key === 'P') {
    e.preventDefault();
    if (isMod) {
      if (!_autoScanActive) _runAutoScan();
    } else {
      if (!_autoScanActive) shadow.getElementById('detect-btn').click();
    }
    return;
  }

  if ((e.key === 'h' || e.key === 'H') && !isMod) {
    shadow.getElementById('hide-btn').click();
  }
});

// ── Initial state ─────────────────────────────────────────────────────────────
// Start collapsed — no table has been scanned yet.
_collapseToIdle();
setStatus('Ready — click Scan.');

// ── Load SVG background then render ─────────────────────────────────────────
const _SVG_SRC = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg
   version="1.1"
   preserveAspectRatio="xMidYMid"
   zoomAndPan="magnify"
   id="Snooker Table"
   viewBox="-4 -37.867 75.779997 143.87272"
   width="758"
   height="1440"
   sodipodi:docname="Snooker_table_drawing_wikipedia.svg"
   inkscape:version="1.4 (e7c3feb1, 2024-10-09)"
   xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
   xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
   xmlns:xlink="http://www.w3.org/1999/xlink"
   xmlns="http://www.w3.org/2000/svg"
   xmlns:svg="http://www.w3.org/2000/svg">
  <sodipodi:namedview
     id="namedview30"
     pagecolor="#ffffff"
     bordercolor="#666666"
     borderopacity="1.0"
     inkscape:showpageshadow="2"
     inkscape:pageopacity="0.0"
     inkscape:pagecheckerboard="0"
     inkscape:deskcolor="#d1d1d1"
     inkscape:zoom="0.31812069"
     inkscape:cx="814.15641"
     inkscape:cy="1029.4835"
     inkscape:window-width="1208"
     inkscape:window-height="726"
     inkscape:window-x="0"
     inkscape:window-y="30"
     inkscape:window-maximized="0"
     inkscape:current-layer="Snooker Table" />
  <defs
     id="defs15">
    <radialGradient
       id="shine"
       cx="0.30000001"
       cy="0.30000001"
       r="0.30000001"
       fx="0.30000001"
       fy="0.30000001">
      <stop
         offset="0"
         stop-color="white"
         stop-opacity=".5"
         id="stop1" />
      <stop
         offset="1"
         stop-color="white"
         stop-opacity="0"
         id="stop2" />
    </radialGradient>
    <radialGradient
       id="shadow"
       cx="0"
       cy="0.30000001"
       r="1">
      <stop
         offset="0"
         stop-color="gray"
         stop-opacity="0"
         id="stop3" />
      <stop
         offset=".5"
         stop-color="black"
         stop-opacity=".1"
         id="stop4" />
      <stop
         offset=".8"
         stop-color="black"
         stop-opacity=".6"
         id="stop5" />
      <stop
         offset="1"
         stop-color="black"
         stop-opacity="1"
         id="stop6" />
    </radialGradient>
    <g
       id="ball">
      <circle
         r="1"
         id="circle6"
         cx="0"
         cy="0" />
      <circle
         r="1"
         fill="url(#shadow)"
         id="circle7"
         cx="0"
         cy="0" />
      <circle
         r="1"
         fill="url(#shine)"
         id="circle8"
         cx="0"
         cy="0" />
    </g>
    <g
       id="reds">
      <g
         id="4reds">
        <use
           xlink:href="#ball"
           fill="#ff0000"
           id="red" />
        <use
           xlink:href="#red"
           transform="translate(-1.7320508,1)"
           id="use8" />
        <use
           xlink:href="#red"
           transform="translate(-3.4641016)"
           id="use9" />
        <use
           xlink:href="#red"
           transform="translate(-1.7320508,-1)"
           id="use10" />
      </g>
      <use
         xlink:href="#4reds"
         transform="translate(-3.4641016,2)"
         id="use11" />
      <use
         xlink:href="#4reds"
         transform="translate(-3.4641016,-2)"
         id="use12" />
      <use
         xlink:href="#red"
         transform="translate(-6.9282032,4)"
         id="use13" />
      <use
         xlink:href="#red"
         transform="translate(-6.9282032)"
         id="use14" />
      <use
         xlink:href="#red"
         transform="translate(-6.9282032,-4)"
         id="use15" />
    </g>
  </defs>
  <rect
     y="-4.0000005"
     x="-106.05037"
     rx="4"
     ry="4"
     width="143.96201"
     height="75.733002"
     fill="#4a2106"
     id="rect15"
     transform="rotate(-90)"
     style="stroke:none;stroke-width:0.2" />
  <rect
     y="-1.7999998"
     x="-103.85036"
     width="139.562"
     height="71.333"
     fill="#006400"
     id="rect16"
     transform="rotate(-90)"
     style="stroke:none;stroke-width:0.2" />
  <rect
     y="-5.7983402e-07"
     x="-102.05037"
     width="135.96201"
     height="67.733002"
     fill="#228b22"
     id="rect17"
     transform="rotate(-90)"
     style="stroke:none;stroke-width:0.2" />
  <path
     d="m 0,-5.835634 h 67.733 m -22.742,0 a 11.124,11.124 0 0 0 -22.248,0"
     stroke="#ffffff"
     fill="none"
     id="path17"
     style="stroke-width:0.2" />
  <g
     id="corner"
     transform="rotate(-90,67.958683,34.091683)"
     style="stroke:none;stroke-width:0.2">
    <polygon
       points="0,-30.867 -2,-33.867 0,-35.867 3,-33.867 "
       fill="#228b22"
       id="polygon17" />
    <polygon
       points="-4,-35.867 -2,-35.867 -2,-37.867 -4,-37.867 0,-37.867 0,-33.867 -4,-33.867 "
       fill="#ffd700"
       id="polygon18" />
    <rect
       x="-4"
       y="-37.867001"
       rx="1.8"
       ry="1.8"
       width="4"
       height="4"
       fill="#ffd700"
       id="rect18" />
    <circle
       cx="-0.69999999"
       cy="-34.567001"
       r="1.55"
       fill="#000000"
       id="circle18" />
  </g>
  <use
     xlink:href="#corner"
     transform="rotate(180,33.867,34.069366)"
     id="use18"
     x="0"
     y="0"
     style="stroke:none;stroke-width:0.2" />
  <use
     xlink:href="#corner"
     transform="rotate(90,67.981,34.069366)"
     id="use19"
     x="0"
     y="0"
     style="stroke:none;stroke-width:0.2" />
  <use
     xlink:href="#corner"
     transform="rotate(-90,33.867,68.183366)"
     id="use20"
     x="0"
     y="0"
     style="stroke:none;stroke-width:0.2" />
  <polygon
     points="69.881,-37.867 69.881,-34.067 66.081,-34.067 66.081,-37.867 "
     fill="#ffd700"
     id="polygon20"
     transform="rotate(-90,67.958683,34.091683)"
     style="stroke:none;stroke-width:0.2" />
  <polygon
     points="71.981,-32.867 69.481,-35.667 66.481,-35.667 63.981,-32.867 "
     fill="#228b22"
     id="polygon21"
     transform="rotate(-90,67.958683,34.091683)"
     style="stroke:none;stroke-width:0.2" />
  <circle
     cx="-34.069363"
     cy="-1.7000014"
     r="1.55"
     fill="#000000"
     id="circle21"
     transform="rotate(-90)"
     style="stroke:none;stroke-width:0.2" />
  <polygon
     points="69.881,37.867 69.881,34.067 66.081,34.067 66.081,37.867 "
     fill="#ffd700"
     id="polygon22"
     transform="rotate(-90,67.958683,34.091683)"
     style="stroke:none;stroke-width:0.2" />
  <polygon
     points="71.981,32.867 69.481,35.667 66.481,35.667 63.981,32.867 "
     fill="#228b22"
     id="polygon23"
     transform="rotate(-90,67.958683,34.091683)"
     style="stroke:none;stroke-width:0.2" />
  <circle
     cx="-34.069363"
     cy="69.433998"
     r="1.55"
     fill="#000000"
     id="circle23"
     transform="rotate(-90)"
     style="stroke:none;stroke-width:0.2" />
  <circle
     style="fill:#000000;fill-opacity:1;stroke:none;stroke-width:0.200048;stroke-dasharray:none"
     id="path30"
     cx="-22.742941"
     cy="-5.8401055"
     transform="scale(-1,1)"
     r="0.29992083" />
  <circle
     style="fill:#000000;fill-opacity:1;stroke:none;stroke-width:0.200048;stroke-dasharray:none"
     id="circle30"
     cx="-33.866703"
     cy="-5.8359065"
     transform="scale(-1,1)"
     r="0.29992083" />
  <circle
     style="fill:#000000;fill-opacity:1;stroke:none;stroke-width:0.200048;stroke-dasharray:none"
     id="circle31"
     cx="-44.987068"
     cy="-5.8359065"
     transform="scale(-1,1)"
     r="0.29992083" />
  <circle
     style="fill:#000000;fill-opacity:1;stroke:none;stroke-width:0.200048;stroke-dasharray:none"
     id="circle32"
     cx="-33.866703"
     cy="34.069359"
     transform="scale(-1,1)"
     r="0.29992083" />
  <circle
     style="fill:#000000;fill-opacity:1;stroke:none;stroke-width:0.200048;stroke-dasharray:none"
     id="circle33"
     cx="-33.866703"
     cy="68.060387"
     transform="scale(-1,1)"
     r="0.29992083" />
  <circle
     style="fill:#000000;fill-opacity:1;stroke:none;stroke-width:0.200048;stroke-dasharray:none"
     id="circle34"
     cx="-33.866703"
     cy="89.704674"
     transform="scale(-1,1)"
     r="0.29992083" />
</svg>`);

const svgImg  = new Image();
svgImg.onload  = scheduleRender;
svgImg.src = _SVG_SRC;
