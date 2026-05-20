// snooker_detect.js — ball detection content script.
// opencv.js (injected before this) sets window.cv to a Promise; resolve it
// here so the rest of the codebase can treat window.cv as the live module.

window.cv.then(function (cvModule) {
  window.cv = cvModule;
  if (typeof onCvReady === 'function') onCvReady();
});

// Call cb(balls, debugInfo) once cv is ready and detection is complete.
// debugMode: if true, _arcDebug/_sideDebug are populated.
// olsSides: if true, use two-pass OLS instead of RANSAC in fitInsetLine.
function waitForCvThenDetect(dataUrl, windowWidth, cb, debugMode, olsSides, checkOnly) {
  if (window.cv && window.cv.Mat) {
    detectBalls(dataUrl, windowWidth, cb, debugMode, olsSides, checkOnly);
  } else {
    setTimeout(() => waitForCvThenDetect(dataUrl, windowWidth, cb, debugMode, olsSides, checkOnly), 100);
  }
}

function detectBalls(dataUrl, windowWidth, cb, debugMode, olsSides, checkOnly) {
  const img = new Image();
  img.onload = () => {
    const detector = new SnookerDetector(img, { debugOn: debugMode, olsSides, checkOnly, windowWidth });
    const balls = detector.detections;
    cb(balls, detector.debugInfo);
  };
  img.src = dataUrl;
  return;
}

let potspotDebugSite = document.querySelector('meta[name="potspot-site"]')?.content;
if (potspotDebugSite) {
	var SV = (k, d) => window.__potspotSiteConfig[potspotDebugSite]?.[k] ?? d;
}
else {
	var SV = (k, d) => window.__potspotSiteConfig?.[k] ?? d;
}

class SnookerDetector {
  constructor(canvas = null, options = {}) {
    this.tableWidth  = 1778;
    this.tableHeight = 3569;
    this.ballWidth   = 51.5;
    this.srcMat      = null;
    this.debugOn     = options.debugOn   || false;
    this.olsSides    = options.olsSides  || true;
    this.checkOnly   = options.checkOnly || false;
    // When true: scan proceeds even when an obstruction is detected.
    // Highlights inside the expanded obstruction zone are masked out so they
    // don't generate spurious ball detections.  The occluded area is passed
    // back in debugInfo.obsRegionsMm for the plan-view overlay.
    this.scanThroughObstructions = options.scanThroughObstructions !== undefined
      ? options.scanThroughObstructions : true;
    this.windowWidth = options.windowWidth || 0;
    this.tableData   = null;
    this.COLOURS = [
      { name:'White',  swatch:'#f5f0dc' },
      { name:'Yellow', swatch:'#F5E621' },
      { name:'Green',  swatch:'#1a7a1a' },
      { name:'Brown',  swatch:'#7a3a10' },
      { name:'Blue',   swatch:'#1a5ab0' },
      { name:'Pink',   swatch:'#e870a0' },
      { name:'Black',  swatch:'#333333' },
      { name:'Red',    swatch:'#cc1010' },
    ];

    if (canvas) {
      this.srcMat = cv.imread(canvas);
      this.detect();
    }
  }




  // ── Perspective: expected ball radius at image-y ──────────────────────────────
  expR(y, tTop, tBot) {
    const t = Math.max(0, Math.min(1, (y - tTop) / (tBot - tTop)));
    const basePx = 18.5 + t * 4.0; // calibrated for ~440px-wide playing area
    const corners = this.tableData?.corners;
    if (corners) {
      const frameW = ((corners.tr.x - corners.tl.x) + (corners.br.x - corners.bl.x)) / 2;
      return basePx * (frameW / 440);
    }
    // No table data yet — scale by tRect width as best estimate
    return basePx * ((tBot - tTop) / 440);
  }

  // Lookup expected ball radius at image-y from the perspective-derived table.
  // Falls back to this.expR() when ballSizes hasn't been populated yet.
  lookupR(y, tTop, tBot) {
    const bs = this.tableData?.ballSizes;
    if (bs) {
      let bestKey = null;
      for (const k of Object.keys(bs)) {
        const kn = +k;
        if (kn <= y && (bestKey === null || kn > bestKey)) bestKey = kn;
      }
      if (bestKey !== null) return bs[bestKey] / 2;
    }
    return this.expR(y, tTop, tBot);
  }

  // Lookup viewing angle (degrees from vertical) at image-y.
  // Falls back to tiltDeg when viewAngles hasn't been populated yet.
  lookupAngle(y) {
    const va = this.tableData?.viewAngles;
    if (va) {
      let bestKey = null;
      for (const k of Object.keys(va)) {
        const kn = +k;
        if (kn <= y && (bestKey === null || kn > bestKey)) bestKey = kn;
      }
      if (bestKey !== null) return va[bestKey];
    }
    return 30;  // fallback: ~typical broadcast snooker camera angle from horizontal
  }

  // ── Table detection ───────────────────────────────────────────────────────────
  findTable(rgba) {
    const SCALE = 0.25;
    let small = new cv.Mat();
    cv.resize(rgba, small, new cv.Size(0, 0), SCALE, SCALE, cv.INTER_AREA);
    let rgb = new cv.Mat();
    cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB);
    small.delete();
    let hsv = new cv.Mat();
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    rgb.delete();

    let mask = new cv.Mat();
    let lo = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [38,50,55,0]);
    let hi = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [88,255,225,255]);
    cv.inRange(hsv, lo, hi, mask);
    hsv.delete(); lo.delete(); hi.delete();

    // 4×4 kernel at 1/4 scale ≡ 16×16 at full res
    let k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(4, 4));
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, k);
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN,  k);
    k.delete();

    let contours = new cv.MatVector(), hier = new cv.Mat();
    cv.findContours(mask, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    mask.delete(); hier.delete();

    let best = null, bestA = 0;
    for (let i = 0; i < contours.size(); i++) {
      const a = cv.contourArea(contours.get(i));
      if (a > bestA) { bestA = a; best = i; }
    }
    if (best === null) { contours.delete(); return null; }
    const r = cv.boundingRect(contours.get(best));
    contours.delete();
    const inv = 1 / SCALE;
    return {
      x:      Math.max(0, Math.round(r.x * inv) - 10),
      y:      Math.max(0, Math.round(r.y * inv) - 10),
      width:  Math.round(r.width  * inv) + 20,
      height: Math.round(r.height * inv) + 20,
    };
  }

  // ── Table edge line detection ─────────────────────────────────────────────────
  // Cyan lines:
  //   Top/bottom — column scan (y = m*x + b), least-squares regression.
  //     These are clean because non-table columns simply have no green pixels.
  //   Left/right — row scan (x = m*y + b), but RANSAC rather than regression.
  //     Regression is thrown off by e.g. a green scoreboard bar extending across
  //     the bottom rows. RANSAC picks random pairs of points, counts inliers
  //     (points within a few px of the line), and keeps the best; outlier rows
  //     never align with the table edge so they never win.
  //   Column scan also records the y-range of the table, which restricts the
  //   row scan so scoreboard rows are excluded before RANSAC even sees them.
  // Orange lines: Canny restricted to a strip just inside each vertical cyan line.
  detectTableEdgeLines(rgba, roughRect = null, hsvIn = null, grayIn = null) {
    const MARGIN = 20;

    // Reuse pre-computed HSV from detect() if available, else compute it
    let hsv;
    const ownHsv = !hsvIn;
    if (hsvIn) {
      hsv = hsvIn;
    } else {
      let rgb = new cv.Mat();
      cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
      hsv = new cv.Mat();
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
      rgb.delete();
    }

    let mask = new cv.Mat();
    let lo = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [38,40,45,0]);
    let hi = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [88,255,235,255]);
    cv.inRange(hsv, lo, hi, mask);
    if (ownHsv) hsv.delete();
    lo.delete(); hi.delete();

    const rows = mask.rows, cols = mask.cols;
    const mdata = mask.data;

    // Restrict scans to roughRect + margin to skip empty regions
    const xS = roughRect ? Math.max(0,        roughRect.x - MARGIN)                         : 0;
    const xE = roughRect ? Math.min(cols - 1, roughRect.x + roughRect.width  + MARGIN)      : cols - 1;
    const yS = roughRect ? Math.max(0,        roughRect.y - MARGIN)                         : 0;
    const yE = roughRect ? Math.min(rows - 1, roughRect.y + roughRect.height + MARGIN)      : rows - 1;

    // ── Column scan → collect top/bottom points and overall y-extent ─────────
    const topPts=[], botPts=[];
    let yMin=rows, yMax=0;

    for (let x = xS; x <= xE; x++) {
      let top=-1, bot=-1;
      // Early-terminate: scan down for first hit, then up for last
      for (let y = yS; y <= yE; y++) { if (mdata[y*cols+x]) { top=y; break; } }
      if (top < 0) continue;
      for (let y = yE; y >= top; y--) { if (mdata[y*cols+x]) { bot=y; break; } }
      topPts.push([x, top]);
      botPts.push([x, bot]);
      if (top < yMin) yMin = top;
      if (bot > yMax) yMax = bot;
    }

    // ── Row scan → left/right points, restricted to table y-range ────────────
    const leftPts=[], rightPts=[];
    for (let y = yMin; y <= yMax; y++) {
      let left=-1, right=-1;
      for (let x = xS; x <= xE; x++) {
        if (mdata[y*cols+x]) { if (left<0) left=x; right=x; }
      }
      if (left >= 0) {
        leftPts.push([left, y]);
        rightPts.push([right, y]);
      }
    }
    mask.delete();

    if (topPts.length < 10 || leftPts.length < 4) return null;

    function solveYofX(sx,sy,sxx,sxy,n) {
      const d=n*sxx-sx*sx; if(!d) return null;
      const m=(n*sxy-sx*sy)/d; return {m, b:(sy-m*sx)/n};
    }
    function solveXofY(sx,sy,syy,sxy,n) {
      const d=n*syy-sy*sy; if(!d) return null;
      const m=(n*sxy-sx*sy)/d; return {m, b:(sx-m*sy)/n};
    }

    // ── RANSAC: fit y=m*x+b (top/bottom — nearly horizontal) ─────────────────
    // Top/bottom use OLS by default but balls blocking the bottom cushion in
    // many columns drag botL upward. RANSAC on all 4 lines fixes this.
    function ransacYofX(pts, iters, thresh) {
      const n = pts.length;
      let bestScore=0, bestM=0, bestB=0;
      for (let i=0; i<iters; i++) {
        const pa = pts[Math.floor(Math.random()*n)];
        const pb = pts[Math.floor(Math.random()*n)];
        const dx = pb[0]-pa[0];
        if (Math.abs(dx) < 5) continue;
        const m=(pb[1]-pa[1])/dx, b=pa[1]-m*pa[0];
        let score=0;
        for (const [x,y] of pts) { if (Math.abs(y-(m*x+b)) <= thresh) score++; }
        if (score > bestScore) { bestScore=score; bestM=m; bestB=b; }
      }
      if (bestScore < 5) return null;
      let sx=0,sy=0,sxx=0,sxy=0,rn=0;
      for (const [x,y] of pts) {
        if (Math.abs(y-(bestM*x+bestB)) <= thresh) { sx+=x; sy+=y; sxx+=x*x; sxy+=x*y; rn++; }
      }
      return solveYofX(sx,sy,sxx,sxy,rn);
    }

    // ── RANSAC: fit x=m*y+b (left/right — nearly vertical) ───────────────────
    function ransacXofY(pts, iters, thresh) {
      const n = pts.length;
      let bestScore=0, bestM=0, bestB=0;
      for (let i=0; i<iters; i++) {
        const pa = pts[Math.floor(Math.random()*n)];
        const pb = pts[Math.floor(Math.random()*n)];
        const dy = pb[1]-pa[1];
        if (Math.abs(dy) < 5) continue;
        const m=(pb[0]-pa[0])/dy, b=pa[0]-m*pa[1];
        let score=0;
        for (const [x,y] of pts) { if (Math.abs(x-(m*y+b)) <= thresh) score++; }
        if (score > bestScore) { bestScore=score; bestM=m; bestB=b; }
      }
      if (bestScore < 5) return null;
      let sx=0,sy=0,syy=0,sxy=0,rn=0;
      for (const [x,y] of pts) {
        if (Math.abs(x-(bestM*y+bestB)) <= thresh) { sx+=x; sy+=y; syy+=y*y; sxy+=x*y; rn++; }
      }
      return solveXofY(sx,sy,syy,sxy,rn);
    }

    const topL  = ransacYofX(topPts,  600, 10);
    const botL  = ransacYofX(botPts,  600, 10);
    const leftL = ransacXofY(leftPts,  600, 15);
    const rightL= ransacXofY(rightPts, 600, 15);
    if (!topL||!botL||!leftL||!rightL) return null;

    function intersect(h, v) { // h: y=m*x+b, v: x=m*y+b
      const den=1-h.m*v.m; if (Math.abs(den)<1e-6) return null;
      const y=(h.m*v.b+h.b)/den, x=v.m*y+v.b;
      return {x:Math.round(x), y:Math.round(y)};
    }
    const tl=intersect(topL,leftL),  tr=intersect(topL,rightL);
    const bl=intersect(botL,leftL),  br=intersect(botL,rightL);
    if (!tl||!tr||!bl||!br) return null;

    const frame = [
      {x1:tl.x, y1:tl.y, x2:tr.x, y2:tr.y},
      {x1:bl.x, y1:bl.y, x2:br.x, y2:br.y},
      {x1:tl.x, y1:tl.y, x2:bl.x, y2:bl.y},
      {x1:tr.x, y1:tr.y, x2:br.x, y2:br.y},
    ];

    // ── Orange: Canny in a strip just inside each vertical cyan side ──────────
    let gray, blurM = new cv.Mat(), edges = new cv.Mat();
    const ownGray = !grayIn;
    if (grayIn) {
      gray = grayIn;
    } else {
      gray = new cv.Mat();
      cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    }
    cv.GaussianBlur(gray, blurM, new cv.Size(3,3), 0);
    cv.Canny(blurM, edges, 30, 90);
    if (ownGray) gray.delete();
    blurM.delete();
    const edata = edges.data;
    const useOls = this.olsSides;

    function fitInsetLine(p1, p2, inward) {
      // Scale INSET with detected frame width so it works at any resolution.
      // At the calibration image size, frame width ≈ 1260px and INSET=50 (≈4%).
      const frameW = ((tr.x - tl.x) + (br.x - bl.x)) / 2;
      const INSET = Math.max(10, Math.round(frameW * 0.04));
      const HALF  = Math.max(5,  Math.round(INSET * 0.6));
      const RANSAC_THRESH = 4, RANSAC_ITERS = 600;
      const yMin2 = Math.min(p1.y, p2.y), yMax2 = Math.max(p1.y, p2.y);
      const dy = p2.y - p1.y; if (!dy) return null;

      // Per row, take only the first Canny pixel scanning inward from the cushion
      // side — left→right for the left line (inward>0), right→left for the right
      // line (inward<0).  This picks the cushion→table edge consistently and avoids
      // accidentally including a second parallel edge further into the strip.
      const pts = [];
      for (let y = yMin2; y <= yMax2 && y < rows; y++) {
        const xCen = Math.round(p1.x + (y - p1.y) / dy * (p2.x - p1.x) + inward * INSET);
        const xL = Math.max(0, xCen - HALF), xR = Math.min(cols - 1, xCen + HALF);
        if (inward > 0) {
          for (let x = xL; x <= xR; x++) { if (edata[y * cols + x]) { pts.push([x, y]); break; } }
        } else {
          for (let x = xR; x >= xL; x--) { if (edata[y * cols + x]) { pts.push([x, y]); break; } }
        }
      }
      if (pts.length < 20) return null;

      let m, b;

      if (useOls) {
        // Two-pass OLS — deterministic, no random sampling.
        // Pass 1: OLS on all points.
        let sx = 0, sy = 0, syy = 0, sxy = 0, n = pts.length;
        for (const [x, y] of pts) { sx += x; sy += y; syy += y * y; sxy += x * y; }
        let den = n * syy - sy * sy; if (!den) return null;
        let m1 = (n * sxy - sx * sy) / den, b1 = (sx - m1 * sy) / n;

        // Pass 2: OLS on inliers within RANSAC_THRESH.
        sx = 0; sy = 0; syy = 0; sxy = 0; n = 0;
        for (const [x, y] of pts) {
          if (Math.abs(x - (m1 * y + b1)) <= RANSAC_THRESH) {
            sx += x; sy += y; syy += y * y; sxy += x * y; n++;
          }
        }
        if (n < 10) return null;
        den = n * syy - sy * sy; if (!den) return null;
        m = (n * sxy - sx * sy) / den;
        b = (sx - m * sy) / n;
      } else {
        // RANSAC: fit x = m*y + b, same pattern as the frame left/right lines.
        let bestM = 0, bestB = 0, bestScore = 0;
        for (let i = 0; i < RANSAC_ITERS; i++) {
          const pa = pts[Math.floor(Math.random() * pts.length)];
          const pb = pts[Math.floor(Math.random() * pts.length)];
          const dyi = pb[1] - pa[1];
          if (Math.abs(dyi) < 5) continue;
          const mi = (pb[0] - pa[0]) / dyi, bi = pa[0] - mi * pa[1];
          let score = 0;
          for (const [x, y] of pts) { if (Math.abs(x - (mi * y + bi)) <= RANSAC_THRESH) score++; }
          if (score > bestScore) { bestScore = score; bestM = mi; bestB = bi; }
        }
        if (bestScore < 10) return null;

        // OLS on inliers only.
        let sx = 0, sy = 0, syy = 0, sxy = 0, n = 0;
        for (const [x, y] of pts) {
          if (Math.abs(x - (bestM * y + bestB)) <= RANSAC_THRESH) {
            sx += x; sy += y; syy += y * y; sxy += x * y; n++;
          }
        }
        const den = n * syy - sy * sy; if (!den) return null;
        m = (n * sxy - sx * sy) / den;
        b = (sx - m * sy) / n;
      }

      return { x1: Math.round(m * yMin2 + b), y1: yMin2, x2: Math.round(m * yMax2 + b), y2: yMax2 };
    }

    const playArea=[fitInsetLine(tl,bl,+1), fitInsetLine(tr,br,-1)].filter(Boolean);
    edges.delete();

    return {frame, playArea, corners: {tl, tr, bl, br}};
  }

  // ── Horizontal cushion boundary lines ────────────────────────────────────────
  // Called after detectTableEdgeLines.  Derives playAreaCorners (pushed outward
  // by cushionWidth so cushion-resting balls are covered) and cushionWidth.
  calcCushionLines() {
    /*
  	this.tableData:
  	corners: {tl: {…}, tr: {…}, bl: {…}, br: {…}}
  	frameBot: {x1: 496, y1: 1423, x2: 2194, y2: 1421}
  	frameLeft: {x1: 720, y1: 209, x2: 496, y2: 1423}
  	frameRight: {x1: 1980, y1: 212, x2: 2194, y2: 1421}
  	frameTop: {x1: 720, y1: 209, x2: 1980, y2: 212}
  	playAreaLeft: {x1: 765, y1: 209, x2: 551, y2: 1423}
  	playAreaRight: {x1: 1935, y1: 212, x2: 2138, y2: 1421}
  	*/
    const td = this.tableData;
    const playAreaCorners = {};

    // If fitInsetLine failed for either side, fall back to frame corners
    // offset inward by a standard cushion fraction (~4% of frame width).
    const frameW = ((td.corners.tr.x - td.corners.tl.x) + (td.corners.br.x - td.corners.bl.x)) / 2;
    const fallbackInset = Math.round(frameW * 0.04);

    const leftLine = td.playAreaLeft || {
      x1: td.corners.tl.x + fallbackInset, y1: td.corners.tl.y,
      x2: td.corners.bl.x + fallbackInset, y2: td.corners.bl.y,
    };
    const rightLine = td.playAreaRight || {
      x1: td.corners.tr.x - fallbackInset, y1: td.corners.tr.y,
      x2: td.corners.br.x - fallbackInset, y2: td.corners.br.y,
    };

    if (leftLine.y2 > leftLine.y1) {
  	// Top to bottom line
  	playAreaCorners.tl = {x: leftLine.x1, y: leftLine.y1};
  	playAreaCorners.bl = {x: leftLine.x2, y: leftLine.y2};
    }
    else {
  	// Bottom to top line
  	playAreaCorners.bl = {x: leftLine.x1, y: leftLine.y1};
  	playAreaCorners.tl = {x: leftLine.x2, y: leftLine.y2};
    }
    if (rightLine.y2 > rightLine.y1) {
  	// Top to bottom line
  	playAreaCorners.tr = {x: rightLine.x1, y: rightLine.y1};
  	playAreaCorners.br = {x: rightLine.x2, y: rightLine.y2};
    }
    else {
  	// Bottom to top line
  	playAreaCorners.br = {x: rightLine.x1, y: rightLine.y1};
  	playAreaCorners.tr = {x: rightLine.x2, y: rightLine.y2};
    }

    // Store the effective cushion-nose lines (with any fallback applied) for
    // use in pixelToTableMm — must happen before cushionWidth is computed.
    this.tableData.noseLeft  = leftLine;
    this.tableData.noseRight = rightLine;

    // Calculate side cushion width
    //this.tableWidth
    let pxmmRatioBottom = this.tableWidth/(playAreaCorners.br.x - playAreaCorners.bl.x);
    let cushionWidthBottomMM = pxmmRatioBottom * ((playAreaCorners.bl.x - td.corners.bl.x) + (td.corners.br.x - playAreaCorners.br.x))/2;
    let pxmmRatioTop = this.tableWidth/(playAreaCorners.tr.x - playAreaCorners.tl.x);
    let cushionWidthTopMM = pxmmRatioTop * ((playAreaCorners.tl.x - td.corners.tl.x) + (td.corners.tr.x - playAreaCorners.tr.x))/2;
	// Because of the way it's calculated, we seem to overestimate cushion width, so take it down 10%
    this.tableData.cushionWidth = 0.95*(cushionWidthBottomMM+cushionWidthTopMM)/2;
    this.tableData.perspective = this.calcPerspective([playAreaCorners.tl,playAreaCorners.tr,playAreaCorners.br,playAreaCorners.bl], this.tableWidth, this.tableHeight);
    playAreaCorners.tl = this.offsetPoint(playAreaCorners.tl, 0, this.tableData.cushionWidth, this.tableData.perspective);
    playAreaCorners.tr = this.offsetPoint(playAreaCorners.tr, 0, this.tableData.cushionWidth, this.tableData.perspective);
    playAreaCorners.br = this.offsetPoint(playAreaCorners.br, 0, -this.tableData.cushionWidth, this.tableData.perspective);
    playAreaCorners.bl = this.offsetPoint(playAreaCorners.bl, 0, -this.tableData.cushionWidth, this.tableData.perspective);

    return playAreaCorners;
  }

  // ── Cushion-fraction position mapping (no homography) ────────────────────────
  // Interpolate x on a {x1,y1,x2,y2} line at a given image row y.
  lineX(line, y) {
    const dy = line.y2 - line.y1;
    if (Math.abs(dy) < 1) return (line.x1 + line.x2) / 2;
    return line.x1 + (y - line.y1) * (line.x2 - line.x1) / dy;
  }

  // Convert a ball-top pixel (topX, topY) to real-world mm on the playing surface.
  //
  // x: fraction between the two cushion-nose lines × tableWidth (linear, ~3.6 mm/px jitter).
  // y: numerical integral of tableWidth / (W(y) * sin(viewAngle(y))) dy from frame top.
  //    W(y) gives the x-scale; dividing by sin(viewAngle) corrects for y-foreshortening.
  //    y=0 is the baulk/D end; cushionWidth offset maps frame-top → playing-surface start.
  pixelToTableMm(topX, topY) {
    const td = this.tableData;
    const L  = td.noseLeft, R = td.noseRight;
    const lx = this.lineX(L, topY);
    const rx = this.lineX(R, topY);
    const W  = rx - lx;
    if (W <= 0) return { x: 0, y: 0 };

    // x: simple fraction
    const x_mm = (topX - lx) / W * this.tableWidth;

    // y: look up precomputed integral, fall back to linear if unavailable
    let y_mm;
    if (td.yIntegral && td.yIntegral.rows.length > 1) {
      y_mm = -td.cushionWidth + this._lookupYIntegral(topY);
    } else {
      const frameH = td.corners.bl.y - td.corners.tl.y;
      y_mm = -td.cushionWidth + (topY - td.corners.tl.y) / (frameH || 1) * (this.tableHeight + 2 * td.cushionWidth);
    }

    return { x: x_mm, y: y_mm };
  }

  // Linear interpolation into the precomputed yIntegral table.
  _lookupYIntegral(y) {
    const { rows, vals } = this.tableData.yIntegral;
    if (y <= rows[0])               return vals[0];
    if (y >= rows[rows.length - 1]) return vals[vals.length - 1];
    let lo = 0, hi = rows.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (rows[mid] <= y) lo = mid; else hi = mid;
    }
    const frac = (y - rows[lo]) / (rows[hi] - rows[lo]);
    return vals[lo] + frac * (vals[hi] - vals[lo]);
  }

  // ── Perspective / homography utilities ────────────────────────────────────────
  // Solve Ax = b by Gauss-Jordan elimination with partial pivoting.
  _gaussSolve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
      let maxRow = col;
      for (let r = col+1; r < n; r++) {
        if (Math.abs(M[r][col]) > Math.abs(M[maxRow][col])) maxRow = r;
      }
      [M[col], M[maxRow]] = [M[maxRow], M[col]];
      const piv = M[col][col];
      if (Math.abs(piv) < 1e-12) return null;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r][col] / piv;
        for (let j = col; j <= n; j++) M[r][j] -= f * M[col][j];
      }
    }
    return M.map((row, i) => row[n] / row[i]);
  }

  // Compute the 3×3 homography (as 9-element row-major array) that maps
  // srcPts[i] → dstPts[i] for 4 point-pairs [{x,y}, …].
  computeHomography(srcPts, dstPts) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const X = srcPts[i].x, Y = srcPts[i].y;
      const u = dstPts[i].x, v = dstPts[i].y;
      // Fix h33=1 and solve for the other 8 elements
      A.push([X, Y, 1, 0, 0, 0, -u*X, -u*Y]); b.push(u);
      A.push([0, 0, 0, X, Y, 1, -v*X, -v*Y]); b.push(v);
    }
    const h = this._gaussSolve(A, b);
    return h ? [...h, 1] : null;
  }

  // Invert a 3×3 homography (9-element row-major array).
  invertH(H) {
    const [a,b,c, d,e,f, g,h,k] = H;
    const det = a*(e*k-f*h) - b*(d*k-f*g) + c*(d*h-e*g);
    if (Math.abs(det) < 1e-12) return null;
    return [
      (e*k-f*h)/det, (c*h-b*k)/det, (b*f-c*e)/det,
      (f*g-d*k)/det, (a*k-c*g)/det, (c*d-a*f)/det,
      (d*h-e*g)/det, (b*g-a*h)/det, (a*e-b*d)/det
    ];
  }

  // Apply a homography H to point (x, y), return {x, y}.
  applyH(H, x, y) {
    const w = H[6]*x + H[7]*y + H[8];
    return { x: (H[0]*x + H[1]*y + H[2])/w,
             y: (H[3]*x + H[4]*y + H[5])/w };
  }

  /**
   * this.calcPerspective(pixelCorners, realWidth, realHeight)
   *
   * Derives the homography for the table plane and estimates the camera tilt.
   *
   * pixelCorners — [tl, tr, br, bl] pixel {x,y} of a known real-world rectangle,
   *                listed clockwise from top-left (e.g. the orange play-area corners).
   * realWidth / realHeight — true dimensions in any consistent unit (e.g. mm).
   *
   * Returns:
   *   H, Hinv    — homographies real↔pixel (9-element row-major arrays)
   *   focalPx    — estimated camera focal length in pixels
   *   tiltDeg    — estimated camera tilt from vertical (0 = looking straight down)
   *   scaleTop   — pixels per real unit at the top edge
   *   scaleBot   — pixels per real unit at the bottom edge
   *
   * Usage: store the result and pass it to this.offsetPoint().
   */
  calcPerspective(pixelCorners, realWidth, realHeight) {
    const [tl, tr, br, bl] = pixelCorners;
    // Real-world corners: TL=(0,0), TR=(W,0), BR=(W,H), BL=(0,H)
    const realCorners = [
      {x: 0,         y: 0},
      {x: realWidth, y: 0},
      {x: realWidth, y: realHeight},
      {x: 0,         y: realHeight}
    ];
    const H = this.computeHomography(realCorners, pixelCorners);
    if (!H) return null;
    const Hinv = this.invertH(H);
    if (!Hinv) return null;

    // Vanishing points: image of the direction vectors [1,0] and [0,1] at infinity
    //   VP_X = H * [1,0,0]^T  →  col 0 of H
    //   VP_Y = H * [0,1,0]^T  →  col 1 of H
    const vpX = { x: H[0]/H[6], y: H[3]/H[6] };
    const vpY = { x: H[1]/H[7], y: H[4]/H[7] };

    // Approximate principal point as the centre of the four pixel corners
    const cx = (tl.x + tr.x + br.x + bl.x) / 4;
    const cy = (tl.y + tr.y + br.y + bl.y) / 4;

    // Focal length from the orthogonality of the two vanishing directions:
    //   (VP_X - PP) · (VP_Y - PP) + f² = 0
    // This fails when VP_X is near-infinity (BBC-style camera aligned with the
    // table's long axis makes cross-table lines nearly parallel → H[6] ≈ 0).
    let f2 = -((vpX.x-cx)*(vpY.x-cx) + (vpX.y-cy)*(vpY.y-cy));

    // Fallback: equal-rotation-vector-magnitude constraint |K⁻¹h₁| = |K⁻¹h₂|.
    // Degenerates only for a perfectly overhead zero-tilt camera (never in broadcast).
    if (!(f2 > 0)) {
      const a0 = H[0]-cx*H[6], b0 = H[3]-cy*H[6];
      const a1 = H[1]-cx*H[7], b1 = H[4]-cy*H[7];
      const den = H[7]*H[7] - H[6]*H[6];
      if (Math.abs(den) > 1e-20) {
        const f2b = (a0*a0 + b0*b0 - a1*a1 - b1*b1) / den;
        if (f2b > 0) f2 = f2b;
      }
    }

    const focalPx = f2 > 0 ? Math.sqrt(f2) : null;

    // Camera tilt = arctan(dist(PP, vanishing-line) / f)
    // The vanishing line runs through VP_X and VP_Y.
    let tiltDeg = null;
    if (focalPx) {
      const dx = vpY.x-vpX.x, dy = vpY.y-vpX.y, len = Math.hypot(dx, dy);
      if (len > 1) {
        const d = Math.abs(dy*(cx-vpX.x) - dx*(cy-vpX.y)) / len;
        tiltDeg = Math.atan2(d, focalPx) * 180 / Math.PI;
      }
    }


    return { H, Hinv, focalPx, tiltDeg, cx, cy };
  }

  /**
   * this.offsetPoint(pixelPt, realDx, realDy, perspective)
   *
   * Given a pixel coordinate that lies on the table plane, return the pixel
   * coordinate of the point shifted by (realDx, realDy) in real-world units.
   *
   * Example — find the inner edge of the top cushion, which is 44 mm inward
   * from the frame top-left corner:
   *
   *   const persp = this.calcPerspective([tl,tr,br,bl], 3568, 1778);
   *   const innerTL = this.offsetPoint(frameTL, 0, 44, persp);
   *   const innerTR = this.offsetPoint(frameTR, 0, 44, persp);
   */
  offsetPoint(pixelPt, realDx, realDy, perspective) {
    const real = this.applyH(perspective.Hinv, pixelPt.x, pixelPt.y);
    return this.applyH(perspective.H, real.x + realDx, real.y + realDy);
  }


  maskToTable(mat, tRect, margin) {
    margin = margin || 5;
    const x = Math.max(0, tRect.x - margin);
    const y = Math.max(0, tRect.y - margin);
    const w = Math.min(mat.cols - x, tRect.width  + margin*2);
    const h = Math.min(mat.rows - y, tRect.height + margin*2);
    let outside = new cv.Mat(mat.rows, mat.cols, cv.CV_8UC1, new cv.Scalar(0));
    let roi = outside.roi(new cv.Rect(x, y, w, h));
    roi.setTo(new cv.Scalar(255)); roi.delete();
    cv.bitwise_and(mat, outside, mat);
    outside.delete();
  }

  // Mask a single-channel Mat to the polygon defined by four corners.
  maskToTablePoly(mat, corners) {
    const pts = cv.matFromArray(4, 1, cv.CV_32SC2, [
      Math.round(corners.tl.x), Math.round(corners.tl.y),
      Math.round(corners.tr.x), Math.round(corners.tr.y),
      Math.round(corners.br.x), Math.round(corners.br.y),
      Math.round(corners.bl.x), Math.round(corners.bl.y),
    ]);
    const mask = cv.Mat.zeros(mat.rows, mat.cols, cv.CV_8UC1);
    const vec = new cv.MatVector();
    vec.push_back(pts);
    cv.fillPoly(mask, vec, new cv.Scalar(255));
    vec.delete(); pts.delete();
    cv.bitwise_and(mat, mask, mat);
    mask.delete();
  }

  // Point-in-convex-quad for corners [tl,tr,br,bl] in screen coords (y down).
  // The winding is clockwise in screen space ≡ counterclockwise in maths,
  // so interior points give a positive cross-product on every edge.
  insidePoly(x, y, corners) {
    const v = [corners.tl, corners.tr, corners.br, corners.bl];
    for (let i = 0; i < 4; i++) {
      const a = v[i], b = v[(i+1)%4];
      if ((b.x-a.x)*(y-a.y) - (b.y-a.y)*(x-a.x) < 0) return false;
    }
    return true;
  }

  // ── Cue line detection ────────────────────────────────────────────────────────
  // Finds line segments in the playing area that are likely to be a cue stick.
  // Uses the S channel (cue is less saturated than baize), Canny edges, and
  // HoughLinesP.  Returns { allLines, cueLines } in full-image pixel coords.
  detectCueLines(hsv) {
    const td = this.tableData;
    if (!td || !td.corners) return { allLines: [], cueLines: [] };

    // Use playAreaCorners (pushed outward by cushionWidth) so the ROI and mask
    // match detectHighlights coverage near the cushions.  Fall back to frame
    // corners if playAreaCorners isn't populated yet.
    const pac    = td.playAreaCorners;
    const hasPac = !!(pac && pac.tl && pac.tr && pac.bl && pac.br);
    const c      = hasPac ? pac : td.corners;   // resolved corners used throughout

    const MARGIN = td.largestBallSizePx / 4;
    // ROI bounding box of c, expanded by MARGIN on all sides (4× at top so
    // cues entering from behind the far cushion are fully captured).
    // roiX/roiY/roiX2/roiY2: image-space corners; roiW/roiH: dimensions.
    const roiX  = Math.max(0,             Math.round(Math.min(c.tl.x, c.tr.x, c.bl.x, c.br.x)) - MARGIN);
    const roiY  = Math.max(0,             Math.round(Math.min(c.tl.y, c.tr.y, c.bl.y, c.br.y)) - 4 * MARGIN);
    const roiX2 = Math.min(hsv.cols - 1,  Math.round(Math.max(c.tl.x, c.tr.x, c.bl.x, c.br.x)) + MARGIN);
    const roiY2 = Math.min(hsv.rows - 1,  Math.round(Math.max(c.tl.y, c.tr.y, c.bl.y, c.br.y)) + MARGIN);
    const roiW  = roiX2 - roiX;
    const roiH  = roiY2 - roiY;
    if (roiW < 10 || roiH < 10) return { allLines: [], cueLines: [] };

    // toL converts full-image coords to ROI-local; used by both the poly mask
    // and (implicitly) the ROI crop below.
    const toL = (px, py) => [Math.round(px - roiX), Math.round(py - roiY)];

    // Split HSV to get S channel; threshold inverted so low-S (cue/cushion) is white
    const channels = new cv.MatVector();
    cv.split(hsv, channels);
    const hChan = channels.get(0), sChan = channels.get(1), vChan = channels.get(2);

    let binary = new cv.Mat();
    {
      const sRoi = sChan.roi(new cv.Rect(roiX, roiY, roiW, roiH));
      cv.threshold(sRoi, binary, 100, 255, cv.THRESH_BINARY_INV);
      sRoi.delete();
    }
    hChan.delete(); sChan.delete(); vChan.delete(); channels.delete();

    // Mask off pixels outside the expanded playing area so cushion rails and
    // frame edges don't generate spurious line detections.  The polygon is
    // expanded by the same MARGIN as the ROI so cue tips entering through the
    // margin zone aren't masked out before Hough can see them.
    if (hasPac) {
      const coords = [
        ...toL(c.tl.x - MARGIN,  c.tl.y - 4 * MARGIN),
        ...toL(c.tr.x + MARGIN,  c.tr.y - 4 * MARGIN),
        ...toL(c.br.x + MARGIN,  c.br.y + MARGIN),
        ...toL(c.bl.x - MARGIN,  c.bl.y + MARGIN),
      ];
      const polyMat = cv.matFromArray(4, 1, cv.CV_32SC2, coords);
      const polyVec = new cv.MatVector();
      polyVec.push_back(polyMat);
      const areaMask = new cv.Mat(roiH, roiW, cv.CV_8U, [0, 0, 0, 0]);
      cv.fillPoly(areaMask, polyVec, [255, 0, 0, 0]);
      cv.bitwise_and(binary, areaMask, binary);
      polyVec.delete(); polyMat.delete(); areaMask.delete();
    }

    // Only downsample when the playing area is large enough that the cue tip
    // would still be detectable at half resolution.
    const SCALE = roiW >= 1000 ? 0.5 : 1.0;

    let working;
    if (SCALE < 1.0) {
      working = new cv.Mat();
      cv.resize(binary, working, new cv.Size(0, 0), SCALE, SCALE, cv.INTER_AREA);
      binary.delete();
    } else {
      working = binary;
    }
    let edges = new cv.Mat();
    cv.Canny(working, edges, 50, 150);
    working.delete();

    // HoughLinesP — minimum line length ≈ 1 ball diameter at current scale.
    // maxLineGap kept small (5% of ball diam) to avoid overshooting the cue tip.
    const ballDiamPxFull = this.ballWidth * roiW / this.tableWidth;
    const minLenScaled   = Math.max(3, Math.round(ballDiamPxFull * SCALE * 0.8));
    const maxGapScaled   = Math.max(1, Math.round(ballDiamPxFull * SCALE * 0.1));
    let linesVec = new cv.Mat();
    cv.HoughLinesP(edges, linesVec, 1, Math.PI / 180, 10, minLenScaled, maxGapScaled);
    edges.delete();

    const allLines      = [];
    const cueLines      = [];
    const maxCueLenFull = roiW / 4;
    // edgeMargin extended by MARGIN so cue endpoints anywhere in the expanded
    // zone (up to MARGIN outside the pac boundary) are still classified as cues.
    const edgeMargin    = ballDiamPxFull * 0.2 + (hasPac ? MARGIN : 0);

    // Build the 4 sides of the playing-area trapezoid for the nearEdge check.
    // Perpendicular distance to the infinite line through each side is used so
    // the cue endpoint just needs to be close to the cushion nose boundary,
    // regardless of where along that side it enters.
    let nearEdge;
    if (hasPac) {
      const sides = [
        { x1: c.tl.x, y1: c.tl.y, x2: c.tr.x, y2: c.tr.y }, // top cushion
        { x1: c.tr.x, y1: c.tr.y, x2: c.br.x, y2: c.br.y }, // right nose
        { x1: c.bl.x, y1: c.bl.y, x2: c.br.x, y2: c.br.y }, // bottom cushion
        { x1: c.tl.x, y1: c.tl.y, x2: c.bl.x, y2: c.bl.y }, // left nose
      ];
      const perpDist = (px, py, l) => {
        const dx = l.x2 - l.x1, dy = l.y2 - l.y1, len = Math.hypot(dx, dy);
        return len > 0 ? Math.abs((py - l.y1) * dx - (px - l.x1) * dy) / len : Infinity;
      };
      nearEdge = (px, py) => sides.some(l => perpDist(px, py, l) < edgeMargin);
    } else {
      // Fallback to bounding box if play area corners unavailable
      nearEdge = (px, py) =>
        px < roiX + edgeMargin || px > roiX2 - edgeMargin ||
        py < roiY + edgeMargin || py > roiY2 - edgeMargin;
    }

    for (let i = 0; i < linesVec.rows; i++) {
      const hx1 = linesVec.data32S[i * 4],     hy1 = linesVec.data32S[i * 4 + 1];
      const hx2 = linesVec.data32S[i * 4 + 2], hy2 = linesVec.data32S[i * 4 + 3];
      // Scaled ROI coords → full image coords
      const fx1 = roiX + hx1 / SCALE, fy1 = roiY + hy1 / SCALE;
      const fx2 = roiX + hx2 / SCALE, fy2 = roiY + hy2 / SCALE;
      const len = Math.hypot(fx2 - fx1, fy2 - fy1);
      const line = { x1: fx1, y1: fy1, x2: fx2, y2: fy2, len };
      allLines.push(line);

      if (len < ballDiamPxFull * 0.5 || len > maxCueLenFull) continue;
      if (nearEdge(fx1, fy1) || nearEdge(fx2, fy2)) cueLines.push(line);
    }
    linesVec.delete();
    return { allLines, cueLines };
  }

  // ── Step 1: Highlight detection ───────────────────────────────────────────────
  // Finds all specular highlight blobs. Returns raw positions — does NOT infer
  // ball centres. White/yellow have large highlights; all other balls are small.
  detectHighlights(gray, tRect, corners) {
    const tTop = tRect.y, tBot = tRect.y + tRect.height;

    // Crop to table bounding box so threshold/morph/findContours work on a
    // fraction of the image rather than the full frame.
    const rx  = Math.max(0, tRect.x);
    const ry  = Math.max(0, tRect.y);
    const rx2 = Math.min(gray.cols - 1, tRect.x + tRect.width);
    const ry2 = Math.min(gray.rows - 1, tRect.y + tRect.height);
    const rw  = rx2 - rx, rh = ry2 - ry;
    const grayRoi = gray.roi(new cv.Rect(rx, ry, rw, rh));

    // Expected ball radius at mid-table — drives threshold and kernel size.
    const erMid = this.tableData?.largestBallSizePx
      ? this.tableData.largestBallSizePx / 2
      : this.expR((tTop + tBot) / 2, tTop, tBot);

    // Threshold: scales down for small/compressed balls. Max is 205 (not 215)
    // to reliably catch the black ball's dim specular, which peaks around 200-210.
    const brightnessThresh = SV('brightnessThresh', Math.round(
      Math.max(180, Math.min(195, 195 - (1 - Math.min(1, erMid / 18.5)) * 15))
    ));
    let bright = new cv.Mat();
    cv.threshold(grayRoi, bright, brightnessThresh, 255, cv.THRESH_BINARY);
    grayRoi.delete();

    if (corners) {
      // Shift frame corners into ROI-local coordinates for the poly mask.
      const lc = {
        tl: { x: corners.tl.x - rx, y: corners.tl.y - ry },
        tr: { x: corners.tr.x - rx, y: corners.tr.y - ry },
        br: { x: corners.br.x - rx, y: corners.br.y - ry },
        bl: { x: corners.bl.x - rx, y: corners.bl.y - ry },
      };
      this.maskToTablePoly(bright, lc);
    }
    // No maskToTable fallback needed — ROI crop already bounds to tRect.

    // ── Pre-close snapshot ────────────────────────────────────────────────────
    // Capture raw highlight centroids before morphological close merges them.
    // Used below to split a merged blob back into two when one raw spot is ≥2×
    // the area of the other — the white ball's whole-top highlight is much
    // larger than any adjacent coloured ball's small specular, so the ratio
    // discriminates cleanly without needing a separation-distance check.
    const rawSpots = [];
    {
      let rawC = new cv.MatVector(), rawH = new cv.Mat();
      cv.findContours(bright, rawC, rawH, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      rawH.delete();
      for (let j = 0; j < rawC.size(); j++) {
        const rc = rawC.get(j);
        const rArea = cv.contourArea(rc);
        if (rArea >= 2) {
          const rM = cv.moments(rc, false);
          if (rM.m00 >= 1) rawSpots.push({
            cx: rM.m10 / rM.m00 + rx,
            cy: rM.m01 / rM.m00 + ry,
            area: rArea,
            r: Math.sqrt(rArea / Math.PI),
          });
        }
        rc.delete();
      }
      rawC.delete();
    }

    // Close twin-dot highlights into a single blob.
    // Kernel must scale with ball size — a fixed 7×7 is too large at low res.
    const kDim = Math.max(3, 2 * Math.round(erMid * 0.19) + 1); // ~7 when er≈18.5
    let k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kDim, kDim));
    cv.morphologyEx(bright, bright, cv.MORPH_CLOSE, k); k.delete();

    let contours = new cv.MatVector(), hier = new cv.Mat();
    cv.findContours(bright, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    bright.delete(); hier.delete();

    const out = [];
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area < 2) { c.delete(); continue; }
      const M = cv.moments(c, false);
      if (M.m00 < 1) { c.delete(); continue; }
      // Offset centroid back to full-image coordinates.
      const hxC = M.m10 / M.m00 + rx;
      const hyC = M.m01 / M.m00 + ry;
      const hr = Math.sqrt(area / Math.PI);
      const er = this.lookupR(hyC, tTop, tBot);
      if (hr < Math.max(0.8, er * 0.08)) { c.delete(); continue; } // min ~8% of ball radius
      if (hr > er) { c.delete(); continue; }
      const large = hr > er * 0.4;
      let hx = hxC, hy = hyC;
      if (large) {
        const rect = cv.boundingRect(c);
        hy = rect.y + ry;  // offset back to full-image y
      }
      c.delete();

      // ── Split check ─────────────────────────────────────────────────────────
      // If ≥2 pre-close raw spots lie within this merged blob and the largest
      // is ≥2× the area of the next (large white-top highlight vs small
      // coloured-ball specular), emit them as two separate highlights.
      // Use hr + er as the search radius so the small spot (whose centroid is
      // pushed away from the merged centroid by the dominant white) is reached.
      {
        const inside = rawSpots.filter(s => {
          const dx = s.cx - hxC, dy = s.cy - hyC;
          return Math.sqrt(dx * dx + dy * dy) <= hr + er;
        });
        if (inside.length >= 2) {
          inside.sort((a, b) => b.area - a.area);
          const big = inside[0], sml = inside[1];
          if (big.area >= 2 * sml.area) {
            const erBig = this.lookupR(big.cy, tTop, tBot);
            const erSml = this.lookupR(sml.cy, tTop, tBot);
            // Guard: only split when one is clearly large (whole-top highlight)
            // and the other is clearly small (specular) — avoids splitting a
            // single white ball whose raw highlight has two uneven fragments.
            if (big.r > erBig * 0.5 && sml.r <= erSml * 0.5) {
              out.push({ hx: big.cx, hy: big.cy - big.r, hr: big.r, large: true });
              out.push({ hx: sml.cx, hy: sml.cy,          hr: sml.r, large: false });
              continue;
            }
          }
        }
      }
      out.push({ hx, hy, hr, large });
    }
    contours.delete();
    return out;
  }

  // Scans a landscape HSV mat (baize at top, ball at bottom) for the baize→ball
  // edge transition, then finds the ball's topmost edge point and its centre column.
  // hxLocal/hyLocal: highlight centroid in mat-local coords (for exclusion + straddle).
  // hr: highlight radius.  er: expected ball radius (for override threshold).
  // earlyColour: { name } from colour identification.
  // Returns { topX, topY, edgePts } in mat-local coords, or null on failure.
  _scanBaizeBallEdge(hsvMat, hxLocal, hyLocal, hr, er, earlyColour, vEdgeThresh = 120) {
    const rows = hsvMat.rows, cols = hsvMat.cols;
    const centreX = Math.round((cols - 1) / 2);
    const EDGE_DH = 10, EDGE_DV = 20, BAIZE_MIN = 3, BAIZE_MIN_FRAC = 0.70;
    const edgePts = [];
    let baizyCols = 0;
    if (earlyColour == "Yellow" || earlyColour == "Pink" ) {
	    hr = 1;
	    vEdgeThresh = 150;
	}

    for (let x = 0; x < cols; x++) {
      let prevH = -1, prevV = -1, baizeCount = 0, edgeFound = false;
      for (let y = 0; y < rows; y += 2) {
        const dhx = x - hxLocal, dhy = y - hyLocal;
        if (dhx * dhx + dhy * dhy < hr * hr) { prevH = -1; prevV = -1; continue; }
        const px = hsvMat.ucharPtr(y, x);
        const H = px[0], S = px[1], V = px[2];
        if (V < 60 && earlyColour?.name !== 'Black') { prevH = -1; prevV = -1; continue; }
        if (H >= 38 && H <= 88 && S > 40 && V > 60) baizeCount++;
        if (!edgeFound && prevH >= 0) {
          const dH = Math.min(Math.abs(H - prevH), 179 - Math.abs(H - prevH));
          const dV = Math.abs(V - prevV);
          if ((dH > EDGE_DH || dV > EDGE_DV) && S > 20) {
            if (V < vEdgeThresh && earlyColour?.name !== 'Black' && earlyColour?.name !== 'Brown') {
              prevH = H; prevV = V; continue;
            }
            edgePts.push({ x, y: Math.max(0, y - 1) });
            edgeFound = true;
          }
        }
        prevH = H; prevV = V;
      }
      if (baizeCount >= BAIZE_MIN) baizyCols++;
    }

    // Pre-filter: need baize in most columns
    if (baizyCols < BAIZE_MIN_FRAC * cols) return null;

    // Need edge points that straddle the highlight centre column
    if (edgePts.length < 5) return null;
    const edgeMinX = Math.min(...edgePts.map(p => p.x));
    const edgeMaxX = Math.max(...edgePts.map(p => p.x));
    if (edgeMinX > centreX - 3 || edgeMaxX < centreX + 3) return null;

    // Find topmost edge point(s) — minimum y = nearest to baize end
    const minY = Math.min(...edgePts.map(p => p.y));
    let topPts = edgePts.filter(p => p.y === minY);
    if (topPts.length === 1) {
      const secondMinY = edgePts.reduce((m, p) => p.y !== minY ? Math.min(m, p.y) : m, Infinity);
      if (secondMinY < Infinity) topPts = edgePts.filter(p => p.y === secondMinY);
    }
    let topX = (Math.min(...topPts.map(p => p.x)) + Math.max(...topPts.map(p => p.x))) / 2;
    let topY = topPts[0].y;

    // If top X deviates too far from mat centre column, override
    if (Math.abs(topX - centreX) > 0.2 * er) {
      topX = centreX;
      const nearPts = edgePts.filter(p => p.x >= centreX - 1 && p.x <= centreX + 1);
      if (nearPts.length >= 2) {
        topY = nearPts.reduce((sum, p) => sum + p.y, 0) / nearPts.length;
      } else {
        return null;
      }
    }

    return { topX, topY, edgePts };
  }

  // ── Step 2: Arc-fit circle detection anchored to highlights ──────────────────
  // For each highlight, scans a bounding rectangle for the ball's top arc by
  // finding columns where the pixel colour transitions from baize to ball.
  // Those edge points are fitted to a circle of known radius via RANSAC.
  // Large highlights (white/yellow) bypass the scan — their topmost pixel is
  // already the ball top.
  detectContours(gray, hsv, highlights, tRect, corners) {
    const tTop = tRect.y, tBot = tRect.y + tRect.height;
    const out = [];
    if (this.debugOn) this._arcDebug = [];

    for (const h of highlights) {
      const er = this.lookupR(h.hy, tTop, tBot);

      if (h.large) {
        // h.hy is already the topmost pixel; ball centre is one radius below it.
        out.push({ cx: h.hx, cy: h.hy + er, r: er, highlight: h,
                   adjusted: false, recovered: false });
        continue;
      }

      // Search rectangle: er wide × er tall, centred on the highlight centroid
      const rectX0 = Math.round(Math.max(0,            h.hx - er ));
      const rectX1 = Math.round(Math.min(gray.cols - 1, h.hx + er ));
      const rectY0 = Math.round(Math.max(0,            h.hy - er ));
      const rectY1 = Math.round(Math.min(gray.rows - 1, h.hy ));

      // Early colour estimate — stored on the highlight for use in edge scan.
      h.earlyColour = this._earlySampleColour(hsv, h);

      // Green balls: hue too close to baize for reliable edge detection.
      if (h.earlyColour.name === 'Green') {
        if (this.debugOn) this._arcDebug.push({
          rect: { x: rectX0, y: rectY0, w: rectX1-rectX0, h: rectY1-rectY0 },
          edgePts: [], topX: undefined, topY: undefined,
        });
        out.push({ cx: h.hx, cy: h.hy + er, r: er, highlight: h,
                   adjusted: false, recovered: true });
        continue;
      }

      // Clip HSV to search rect; delegate scan + "find top centre" to shared fn.
      const scanRoi = hsv.roi(new cv.Rect(rectX0, rectY0, rectX1-rectX0+1, rectY1-rectY0+1));
      const scan = this._scanBaizeBallEdge(
        scanRoi, h.hx - rectX0, h.hy - rectY0, h.hr, er, h.earlyColour
      );
      scanRoi.delete();

      if (!scan) {
        if (this.debugOn) this._arcDebug.push({
          rect: { x: rectX0, y: rectY0, w: rectX1-rectX0, h: rectY1-rectY0 },
          edgePts: [], topX: undefined, topY: undefined,
        });
        out.push({ cx: h.hx, cy: h.hy + er, r: er, highlight: h,
                   adjusted: false, recovered: true });
        continue;
      }

      const topX = rectX0 + scan.topX;
      const topY = rectY0 + scan.topY;

      if (this.debugOn) this._arcDebug.push({
        rect: { x: rectX0, y: rectY0, w: rectX1-rectX0, h: rectY1-rectY0 },
        edgePts: scan.edgePts.map(p => ({ x: rectX0 + p.x, y: rectY0 + p.y })),
        topX, topY,
      });

      out.push({ cx: topX, cy: topY + er, r: er, highlight: h,
                 adjusted: false, recovered: false });
    }

    return out;
  }


  pairAndCorrect(circles, highlights) {
    // Yellow has a large-ish highlight that doesn't reliably sit at the ball
    // top, so use a lower fraction than the .large threshold to exclude it
    // from both building and receiving the median offset.
    const MEDIAN_HR_FRAC = 0.35;
    const tooLargeForMedian = d =>
      d.highlight.large || d.highlight.hr > d.r * MEDIAN_HR_FRAC;

    // Build the offset model exclusively from edge-detected (non-recovered,
    // non-large) balls — recovered balls have dx=dy=0 which would poison the
    // model if included.
    const anchors = [];
    for (const d of circles) {
      if (!d.highlight || tooLargeForMedian(d) || d.recovered) continue;
      anchors.push({
        dx: d.cx - d.highlight.hx,
        dy: (d.cy - d.r) - d.highlight.hy,
      });
    }

    if (anchors.length < 2) return { detections: circles, mDx: null, mDy: null };

    const mDx = this.median(anchors.map(a => a.dx));
    const mDy = this.median(anchors.map(a => a.dy));

    // Apply the median offset to recovered balls; leave all others as-is.
    const detections = circles.map(d => {
      if (!d.highlight || (d.adjusted && tooLargeForMedian(d))) return d;
      let madj = 1;
      if (d.highlight.hr > d.r * MEDIAN_HR_FRAC) {
        // highlight cutoff divided by (actual highlight size*4) seems to work, but adjust to taste
        // Below, we multiply the median adjustment by this amount before applying
      	madj = (d.r * MEDIAN_HR_FRAC)/(4*d.highlight.hr); 
      }
      return { ...d,
        cx: d.highlight.hx + mDx,
        cy: d.highlight.hy + mDy*madj + d.r,
      };
    });

    return { detections, mDx, mDy };
  }

  // ── Side-edge refinement for isolated balls ──────────────────────────────────
  // After pairAndCorrect, scan left and right of each ball that has no neighbour
  // within 1.2 ball-widths. Side rects (portrait in image space) are rotated to
  // landscape (baize-top) before calling _scanBaizeBallEdge, so the same "find
  // top centre" logic applies. The returned topX/topY are unrotated back to image
  // coords to give the left/right edge points.
  adjustSidePositions(dets, hsv, highlights, tRect) {
    const ISO_R_FACTOR  = 2.2;   // 1.1 ball-widths = 2.2 * er
    const Y_TOL_FRAC    = 0.3;
    const X_TOL_FRAC    = 0.4;
    const MAX_MOVE_FRAC = 0.25;

    if (this.debugOn) this._sideDebug = [];

    return dets.map(det => {
      const h = det.highlight;
      if (!h) return det;
      const er = det.r;

      // Only process isolated balls
      const isoR2 = (ISO_R_FACTOR * er) ** 2;
      if (!highlights.every(oh => oh === h || (oh.hx-h.hx)**2 + (oh.hy-h.hy)**2 > isoR2))
        return det;

      if (!h.earlyColour) h.earlyColour = this._earlySampleColour(hsv, h);
      if (h.earlyColour.name === 'Green') return det;

      const { cx, cy } = det;
      const d = cy - h.hy;   // mirrors top-rect offset from ball centre ≈ er

      // Image-space rects bracketing the ball's left/right edges; clamped to image bounds.
      const sideY0  = Math.round(Math.max(0,            cy - er));
      const sideY1  = Math.round(Math.min(hsv.rows - 1, cy + er));
      const leftX0  = Math.round(Math.max(0,            cx - d - er));
      const leftX1  = Math.round(Math.min(hsv.cols - 1, cx - d));
      const rightX0 = Math.round(Math.max(0,            cx + d));
      const rightX1 = Math.round(Math.min(hsv.cols - 1, cx + d + er));

      if (leftX0 >= leftX1 || rightX0 >= rightX1 || sideY0 >= sideY1) return det;

      // ── Left rect: portrait, rotate CW → landscape (baize at top) ──────────
      // CW: src(x_s, y_s) → dest(H-1-y_s, x_s)  [H = source height = sideY1-sideY0+1]
      // Highlight in rotated mat: col = H-1-(h.hy-sideY0), row = h.hx-leftX0
      const lH = sideY1 - sideY0 + 1;
      const lRoi = hsv.roi(new cv.Rect(leftX0, sideY0, leftX1-leftX0+1, lH));
      const lRot = new cv.Mat();
      cv.rotate(lRoi, lRot, cv.ROTATE_90_CLOCKWISE);
      lRoi.delete();
      const lScan = this._scanBaizeBallEdge(
        lRot,
        lH - 1 - (h.hy - sideY0),   // hxLocal in rotated mat (exclusion circle only)
        h.hx - leftX0,               // hyLocal in rotated mat (exclusion circle only)
        h.hr, er, h.earlyColour, 40
      );
      lRot.delete();
      if (!lScan) return det;
      // Unrotate CW: src_x = topY, src_y = H-1-topX
      const leftEdgePt = { x: leftX0 + lScan.topY, y: sideY1 - lScan.topX };

      // ── Right rect: portrait, rotate CCW → landscape (baize at top) ─────────
      // CCW: src(x_s, y_s) → dest(y_s, W-1-x_s)  [W = source width = rightX1-rightX0+1]
      // Highlight in rotated mat: col = h.hy-sideY0, row = W-1-(h.hx-rightX0)
      const rW = rightX1 - rightX0 + 1;
      const rH = sideY1 - sideY0 + 1;
      const rRoi = hsv.roi(new cv.Rect(rightX0, sideY0, rW, rH));
      const rRot = new cv.Mat();
      cv.rotate(rRoi, rRot, cv.ROTATE_90_COUNTERCLOCKWISE);
      rRoi.delete();
      const rScan = this._scanBaizeBallEdge(
        rRot,
        h.hy - sideY0,               // hxLocal in rotated mat (exclusion circle only)
        rW - 1 - (h.hx - rightX0),   // hyLocal in rotated mat (exclusion circle only)
        h.hr, er, h.earlyColour, 60
      );
      rRot.delete();
      if (!rScan) return det;
      // Unrotate CCW: src_x = W-1-topY, src_y = topX
      const rightEdgePt = { x: rightX1 - rScan.topY, y: sideY0 + rScan.topX };

      // Collect debug data — unrotate edge points back to image coords
      if (this.debugOn) {
        const leftImgPts  = lScan.edgePts.map(p => ({ x: leftX0  + p.y, y: sideY1 - p.x }));
        const rightImgPts = rScan.edgePts.map(p => ({ x: rightX1 - p.y, y: sideY0 + p.x }));
        this._sideDebug.push({
          leftEdgePt, rightEdgePt, leftImgPts, rightImgPts,
          leftRect:  { x: leftX0,  y: sideY0, w: leftX1  - leftX0,  h: sideY1 - sideY0 },
          rightRect: { x: rightX0, y: sideY0, w: rightX1 - rightX0, h: sideY1 - sideY0 },
        });
      }

      // Validate: same Y level and approximately one diameter apart
      if (Math.abs(leftEdgePt.y - rightEdgePt.y) > Y_TOL_FRAC * er) return det;
      if (Math.abs(rightEdgePt.x - leftEdgePt.x - (2 * er)) > X_TOL_FRAC * er) return det;

      const newCx = (leftEdgePt.x + rightEdgePt.x) / 2;
      let newCy = (leftEdgePt.y + rightEdgePt.y) / 2;
      if (h.earlyColour.name == 'Yellow') {
	    // Yellow often gets located too low, so take it towards min side Y
        newCy = (newCy + Math.min(leftEdgePt.y,rightEdgePt.y))/2;
	  }
      if (newCy < cy && h.earlyColour.name != 'Yellow') {
      	// Rarely do we want to move balls upwards, put it back
      	newCy = cy;
      }
      if (Math.hypot(newCx - cx, newCy - cy) > MAX_MOVE_FRAC * er) return det;

      return { ...det, cx: newCx, cy: newCy, adjusted: true };
    });
  }


  median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;
  }

  // ── Colour identification by HSV sampling ─────────────────────────────────────

  // Early colour estimate from highlight blob alone (no ball centre needed).
  // Samples 6 points around the highlight at hr+2 and hr+4 pixels: two below
  // (where the ball body is) and two each side. Returns majority _matchHSV result.
  // Returns true if pixel (x, y) lies inside the playAreaCorners trapezoid.
  // Uses cross-product sign test on each edge of the convex quad (tl→tr→br→bl).
  _inPlayArea(x, y) {
    const c = this.tableData && this.tableData.playAreaCorners;
    if (!c) return true; // no data yet — don't filter
    const pts = [c.tl, c.tr, c.br, c.bl];
    for (let i = 0; i < 4; i++) {
      const a = pts[i], b = pts[(i + 1) % 4];
      if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < 0) return false;
    }
    return true;
  }

  _earlySampleColour(hsv, h) {
    const hr = h.hr;
    const offsets = [
      [0, hr + 2], [0, hr + 4],
      [-(hr + 2), 0], [hr + 2, 0],
      [-(hr + 4), 0], [hr + 4, 0],
    ];
    const votes = {};
    for (const [dx, dy] of offsets) {
      const sx = Math.max(0, Math.min(hsv.cols - 1, Math.round(h.hx + dx)));
      const sy = Math.max(0, Math.min(hsv.rows - 1, Math.round(h.hy + dy)));
      if (!this._inPlayArea(sx, sy)) continue;
      const pixel = hsv.ucharPtr(sy, sx);
      const colour = this._matchHSV(pixel[0], pixel[1], pixel[2]);
      if (!votes[colour.name]) votes[colour.name] = { colour, n: 0 };
      votes[colour.name].n++;
    }
    let best = null;
    for (const v of Object.values(votes)) {
      if (!best || v.n > best.n) best = v;
    }
    return best ? best.colour : { name: '?', swatch: '#888888' };
  }

  _matchHSV(H, S, V) {
    if (V < 60)                                  return this.COLOURS[6]; // Black
    if ((H < 10 || H > 165) && S > 35 && V>200) return this.COLOURS[5]; // Pink
    if ((H < 10 || H > 163) && S > 90)          return this.COLOURS[7]; // Red
    if (H >= 5  && H < 30 && S > 120 && V < 180) return this.COLOURS[3]; // Brown
    if (H >= 18 && H < 36 && S > 110)           return this.COLOURS[1]; // Yellow
    if (H >= 38 && H < 78 && S > 50 && V < 168) return this.COLOURS[2]; // Green
    if (H >= 95 && H < 128 && S > 70)           return this.COLOURS[4]; // Blue
    if (V > 140 && S < 150)                      return this.COLOURS[0]; // White
    if (this.debugOn) console.log(H,S,V);
    return { name:'?', swatch:'#888888' };
  }

  identifyColour(hsv, cx, cy, r, highlight, otherDets = []) {
    // Sample every pixel in the top semicircle of the ball, shrunk by a margin
    // to avoid baize-bleed at the edge.  Exclude the highlight blob and any
    // pixel that falls inside another detected ball's circle.  Then take the
    // median H, S, V — much more robust than a handful of point samples.
    const margin = Math.max(2, Math.round(0.1 * r));   // 5 % of ball diameter
    const er2    = (r - margin) * (r - margin);

    const Hvals = [], Svals = [], Vvals = [];
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(hsv.cols - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(hsv.rows - 1, Math.floor(cy));  // top semicircle

    for (let row = y0; row <= y1; row++) {
      for (let col = x0; col <= x1; col++) {
        const dx = col - cx, dy = row - cy;
        if (dx * dx + dy * dy > er2) continue;          // outside shrunk circle
        if (!this._inPlayArea(col, row)) continue;

        // Exclude the highlight blob.
        if (highlight) {
          const hdx = col - highlight.hx, hdy = row - highlight.hy;
          if (hdx * hdx + hdy * hdy < highlight.hr * highlight.hr) continue;
        }

        // Exclude pixels inside any other detected ball.
        let inOther = false;
        for (const o of otherDets) {
          const odx = col - o.cx, ody = row - o.cy;
          if (odx * odx + ody * ody < o.r * o.r) { inOther = true; break; }
        }
        if (inOther) continue;

        const pixel = hsv.ucharPtr(row, col);
        Hvals.push(pixel[0]);
        Svals.push(pixel[1]);
        Vvals.push(pixel[2]);
      }
    }

    if (!Hvals.length) {
      // No usable pixels — fall back to ball centre.
      const pixel = hsv.ucharPtr(
        Math.max(0, Math.min(hsv.rows - 1, Math.round(cy))),
        Math.max(0, Math.min(hsv.cols - 1, Math.round(cx)))
      );
      return this._matchHSV(pixel[0], pixel[1], pixel[2]);
    }

    Svals.sort((a, b) => a - b);
    Vvals.sort((a, b) => a - b);
    const medS = Svals[Math.floor(Svals.length / 2)];
    const medV = Vvals[Math.floor(Vvals.length / 2)];

    // Median H with red-discontinuity handling.
    // OpenCV H is 0–179; red/pink spans H < 10 and H > 165, straddling 0.
    // When both low and high values are present, shift low values up by 180
    // before sorting so the median crosses the gap correctly, then wrap back.
    let medH;
    const hasVeryLow  = Hvals.some(h => h < 30);
    const hasVeryHigh = Hvals.some(h => h > 150);
    if (hasVeryLow && hasVeryHigh) {
      const adj = Hvals.map(h => h < 90 ? h + 180 : h);
      adj.sort((a, b) => a - b);
      medH = adj[Math.floor(adj.length / 2)] % 180;
    } else {
      Hvals.sort((a, b) => a - b);
      medH = Hvals[Math.floor(Hvals.length / 2)];
    }

    return this._matchHSV(medH, medS, medV);
  }

  // ── Dedup non-red singles (prefer detections that have a highlight) ───────────
  dedupSingles(dets, hsv) {
    // When multiple pinks are detected, keep only the pinkest (lowest S = most
    // pastel/pale) and demote the rest to Red.  Pink and Red share the same hue
    // range; saturation is the key differentiator — true pink has lower S.
    const pinks = dets.filter(d => d.colour.name === 'Pink');
    if (pinks.length > 1) {
      const sampleS = d => {
        const sx = Math.max(0, Math.min(hsv.cols - 1, Math.round(d.cx)));
        const sy = Math.max(0, Math.min(hsv.rows - 1, Math.round(d.cy)));
        return hsv.ucharPtr(sy, sx)[1];
      };
      pinks.sort((a, b) => sampleS(a) - sampleS(b));  // ascending: lowest S first
      for (const d of pinks.slice(1)) d.colour = this.COLOURS[7]; // Red
    }

    const reds   = dets.filter(d => d.colour.name === 'Red');
    const others = dets.filter(d => d.colour.name !== 'Red');
    const seen = {};
    const dupes = []; // losers displaced by a same-colour winner
    for (const d of others) {
      const k = d.colour.name;
      if (!seen[k]) {
        seen[k] = d;
      } else if (d.highlight && !seen[k].highlight) {
        dupes.push(seen[k]);
        seen[k] = d;
      } else {
        dupes.push(d);
      }
    }
    const result = [...Object.values(seen), ...reds];

    // Backstop: if no White was detected but duplicates exist, promote the
    // lightest duplicate (highest V at ball centre) to White.
    if (!seen['White'] && hsv && dupes.length > 0) {
      const sampleV = d => {
        const sx = Math.max(0, Math.min(hsv.cols - 1, Math.round(d.cx)));
        const sy = Math.max(0, Math.min(hsv.rows - 1, Math.round(d.cy)));
        return hsv.ucharPtr(sy, sx)[2];
      };
      dupes.sort((a, b) => sampleV(b) - sampleV(a));
      dupes[0].colour = this.COLOURS[0]; // White
      result.push(dupes[0]);
    }

    return result;
  }

  // ── Green validation ──────────────────────────────────────────────────────────
  // Green's hue overlaps the baize, making it prone to false positives from baize
  // highlights/artefacts.  Two guards applied to every Green detection:
  //   1. Spatial: reject if it overlaps another ball (centre-to-centre < OVERLAP×r)
  //      or if its centre lies outside the play area (on the cushion face).
  //   2. Shape: run a low-threshold HoughCircles on a gray ROI centred on the
  //      detection; reject if no circle of roughly the right radius is found.
  _filterSpuriousGreen(detections, gray) {
    const OVERLAP_DIST = 1.8;   // ×r — reject if another ball centre is this close
    const HOUGH_PARAM1 = 30;    // Canny high threshold (low = sensitive edges)
    const HOUGH_PARAM2 = 10;    // accumulator threshold (low = accept weak circles)
    const HOUGH_R_LO   = 0.65;  // min accepted radius as fraction of expected r
    const HOUGH_R_HI   = 1.35;  // max accepted radius as fraction of expected r
    const HOUGH_REACH  = 1.5;   // max distance (×r) from expected centre to accepted circle

    return detections.filter(d => {
      if (d.colour.name !== 'Green') return true;

      const { cx, cy, r } = d;

      // 1a. Overlaps another detection
      if (detections.some(o => o !== d && Math.hypot(o.cx - cx, o.cy - cy) < OVERLAP_DIST * r)) {
        if (this.debugOn) console.log('[green] rejected: overlaps another ball at', Math.round(cx), Math.round(cy));
        return false;
      }

      // 1b. Centre outside the play area (on cushion face / frame)
      if (!this._inPlayArea(cx, cy)) {
        if (this.debugOn) console.log('[green] rejected: outside play area at', Math.round(cx), Math.round(cy));
        return false;
      }

      // 2. Shape check: look for a circle of roughly the right radius in gray.
      //    Low thresholds because the green/baize edge is subtle.
      if (!gray) return true;

      const pad  = Math.ceil(r * 2);
      const roiX = Math.max(0, Math.round(cx - pad));
      const roiY = Math.max(0, Math.round(cy - pad));
      const roiW = Math.min(gray.cols - roiX, Math.round(pad * 2));
      const roiH = Math.min(gray.rows - roiY, Math.round(pad * 2));
      if (roiW < r || roiH < r) return true;   // ROI too small to test, give benefit of doubt

      const gRoi    = gray.roi(new cv.Rect(roiX, roiY, roiW, roiH));
      const circles = new cv.Mat();
      cv.HoughCircles(gRoi, circles, cv.HOUGH_GRADIENT,
        /* dp */ 1,
        /* minDist */ r,                          // expect at most one circle here
        HOUGH_PARAM1, HOUGH_PARAM2,
        Math.round(r * HOUGH_R_LO),
        Math.round(r * HOUGH_R_HI));
      gRoi.delete();

      // Check if any found circle is close to the expected ball centre in the ROI
      const expX = cx - roiX, expY = cy - roiY;
      let shapeOk = false;
      for (let i = 0; i < circles.cols; i++) {
        const hx = circles.data32F[i * 3];
        const hy = circles.data32F[i * 3 + 1];
        if (Math.hypot(hx - expX, hy - expY) < HOUGH_REACH * r) { shapeOk = true; break; }
      }
      circles.delete();

      if (!shapeOk) {
        if (this.debugOn) console.log('[green] rejected: no Hough circle found near', Math.round(cx), Math.round(cy));
        return false;
      }

      return true;
    });
  }

  // ── White rescue ─────────────────────────────────────────────────────────────
  // Run BEFORE dedupSingles so we can see all Yellow detections at once.
  // Case 1: two+ yellows → the less saturated one is the white cue ball.
  // Case 2: one yellow, no reds → the yellow must be the white cue ball.
  _rescueWhite(detections, hsv) {
    if (detections.some(d => d.colour.name === 'White')) return detections;

    const yellows = detections.filter(d => d.colour.name === 'Yellow');

    if (yellows.length >= 2) {
      // Score each yellow by average S across 4 body points — lowest S = whitest.
      const avgS = d => {
        const pts = [[0, 0.15], [0.3, 0.1], [-0.3, 0.1], [0, 0.35]];
        let sum = 0;
        for (const [dx, dy] of pts) {
          const sx = Math.max(0, Math.min(hsv.cols-1, Math.round(d.cx + dx * d.r)));
          const sy = Math.max(0, Math.min(hsv.rows-1, Math.round(d.cy + dy * d.r)));
          sum += hsv.ucharPtr(sy, sx)[1];
        }
        return sum / pts.length;
      };
      yellows.sort((a, b) => avgS(a) - avgS(b));
      yellows[0].colour = this.COLOURS[0]; // White
      return detections;
    }

    // One yellow, no reds: the yellow is the white ball.
    if (yellows.length === 1 && !detections.some(d => d.colour.name === 'Red')) {
      yellows[0].colour = this.COLOURS[0]; // White
    }

    return detections;
  }

  // ── Brown rescue ─────────────────────────────────────────────────────────────
  // Priority 1: any unknown ('?') ball that looks vaguely brown.
  // Priority 2: a red that is measurably more orange than the other reds.
  _rescueBrown(detections, hsv) {
    const BROWN_HUE_DIST = 8;  // min gap (in OpenCV hue units, 0-179) to trigger red rescue

    const hasName = n => detections.some(d => d.colour.name === n);
    if (hasName('Brown')) return detections;

    // Sample 4 pixels around a ball centre, return median H/S/V.
    const sampleHSV = d => {
      const off = d.r * 0.3;
      const Hs = [], Ss = [], Vs = [];
      for (const [dx, dy] of [[0, 0], [off, 0], [-off, 0], [0, off]]) {
        const sx = Math.max(0, Math.min(hsv.cols-1, Math.round(d.cx + dx)));
        const sy = Math.max(0, Math.min(hsv.rows-1, Math.round(d.cy + dy)));
        const p = hsv.ucharPtr(sy, sx);
        Hs.push(p[0]); Ss.push(p[1]); Vs.push(p[2]);
      }
      return { H: this.median(Hs), S: this.median(Ss), V: this.median(Vs) };
    };

    // Priority 1: unknown ball that falls in a generous brown HSV range.
    // Brown center ≈ H=11 in OpenCV (0-179); allow H∈[3,25], some saturation, not black.
    const unknowns = detections.filter(d => d.colour.name === '?');
    if (unknowns.length) {
      const brownScore = d => {
        const { H, S, V } = sampleHSV(d);
        if (H < 3 || H > 25 || S < 30 || V < 40) return null;
        return 25 - Math.abs(H - 11); // higher = closer to brown hue center
      };
      const candidates = unknowns
        .map(d => ({ d, score: brownScore(d) }))
        .filter(c => c.score !== null);
      if (candidates.length) {
        candidates.sort((a, b) => b.score - a.score);
        candidates[0].d.colour = this.COLOURS[3]; // Brown
        return detections;
      }
    }

    // Priority 2: a red that is measurably more orange/brown than the others.
    const reds = detections.filter(d => d.colour.name === 'Red');
    if (!reds.length) return detections;

    // One red and no brown is not a valid table state — it must be the brown.
    if (reds.length === 1) {
      reds[0].colour = this.COLOURS[3];
      return detections;
    }

    // Multiple reds: only attempt outlier rescue when Yellow + Green are present.
    if (!hasName('Yellow') || !hasName('Green')) return detections;

    // Non-redness: min(H, 179-H) so 0 = pure red, higher = more orange/brown.
    const nonRedness = d => {
      const { H } = sampleHSV(d);
      return Math.min(H, 179 - H);
    };

    const scored = reds.map(r => ({ r, score: nonRedness(r) }));
    scored.sort((a, b) => b.score - a.score);

    const candidate = scored[0];
    const othersMedian = this.median(scored.slice(1).map(s => s.score));
    if (candidate.score - othersMedian < BROWN_HUE_DIST) return detections;

    candidate.r.colour = this.COLOURS[3];  // Brown
    return detections;
  }

  // ── Table-clear check ────────────────────────────────────────────────────────
  // Two-stage gate:
  //  1. Frame geometry — corners in-frame, table spans ≥35% of image height.
  //  2. Non-green blob analysis (at adaptive downscale) — called after highlights
  //     so ball positions can be masked out before checking.  Top of playing
  //     area excluded (shadow under top cushion).  Any surviving blob with max
  //     dimension ≥ average ball radius counts as an obstruction.
  // Returns { suitable, reason, contours[] } in full-res image-pixel coords.
  checkTableClear(rgb, highlights, gray = null) {
	const MINWIDTH = 500;
    const td    = this.tableData;

	const pixelDensity = this.srcMat.cols/this.windowWidth;


    // ── Stage 1: frame geometry ────────────────────────────────────────────────
    if (!td?.corners || !td.noseLeft || !td.noseRight) {
      return { suitable: false, reason: 'Table geometry not detected', contours: [], blurScore: null };
    }
    const { tl, tr, bl, br } = td.corners;

    //if ((br.x-bl.x)/pixelDensity < MINWIDTH) {
    //  return { suitable: false, reason: 'Table is too small on-screen', contours: [], blurScore: null };
    //}
    const imgW = this.srcMat.cols, imgH = this.srcMat.rows;
    const MARGIN = 0.10;
    const inFrame = (p) =>
      p.x > -imgW * MARGIN && p.x < imgW * (1 + MARGIN) &&
      p.y > -imgH * MARGIN && p.y < imgH * (1 + MARGIN);
    if (!inFrame(tl) || !inFrame(tr) || !inFrame(bl) || !inFrame(br)) {
      return { suitable: false, reason: 'Partial view — table extends beyond frame', contours: [], blurScore: null };
    }
    if ((bl.y - tl.y) / imgH < 0.35) {
      return { suitable: false, reason: 'Full table not visible', contours: [], blurScore: null };
    }
	//if (widthRatio < 1) {
    if ((br.x-bl.x)/pixelDensity < MINWIDTH) {
      return { suitable: false, reason: 'Table is too small on-screen', contours: [], blurScore: null };
	}
	// Scale to 1,2 or 4
	let widthRatio = Math.floor((imgW/pixelDensity) / MINWIDTH);
	if (widthRatio > 4) { widthRatio = 4 }
	else if (widthRatio > 2) {widthRatio = 2}
	else {widthRatio = 1}
	
    const SCALE = 1/widthRatio;



    // ── Stage 2: non-green blob analysis at adaptive downscale ────────────────
    let small = new cv.Mat();
    cv.resize(rgb, small, new cv.Size(0, 0), SCALE, SCALE, cv.INTER_AREA);
    let hsvQ = new cv.Mat();
    cv.cvtColor(small, hsvQ, cv.COLOR_RGB2HSV);
    small.delete();

    let nonGreen = new cv.Mat();
    let lo = new cv.Mat(hsvQ.rows, hsvQ.cols, hsvQ.type(), [38, 50, 55, 0]);
    let hi = new cv.Mat(hsvQ.rows, hsvQ.cols, hsvQ.type(), [85, 255, 255, 0]);
    cv.inRange(hsvQ, lo, hi, nonGreen);
    lo.delete(); hi.delete();
    // hsvQ kept alive until after the shadow-zone erase below
    cv.bitwise_not(nonGreen, nonGreen);

    // Average ball radius at mid-table (quarter scale) — used for masking and threshold
    const S      = SCALE;
    const midY   = (tl.y + bl.y) / 2;
    const W_mid  = this.lineX(td.noseRight, midY) - this.lineX(td.noseLeft, midY);
    const avgEr_q = (this.ballWidth / 2) * (W_mid / this.tableWidth) * S;

    // Shadow zone: top cushion casts a dark band just inside the top frame line.
    // Always computed so the contour classifier can ignore blobs that sit almost
    // entirely within it, regardless of which poly mask is in use.
    // Derives playTopY/playBotY (image rows for the playing-area top/bottom) and
    // shadowY (row 5% into the playing area, below the shadow band).
    const frameSpanY   = bl.y - tl.y;
    const cushionFracY = td.cushionWidth / (this.tableHeight + 2 * td.cushionWidth);
    const cushionPxY   = cushionFracY * frameSpanY;
    const playTopY     = tl.y + cushionPxY;
    const playBotY     = bl.y - cushionPxY;
    const shadowY      = playTopY + 0.05 * (playBotY - playTopY);  // 5% into playing area

    // Poly mask for the non-green blob search.
    // scanThroughObstructions: use the full frame-corner trapezoid so a player's
    // body is captured even where it overlaps the cushion face.  The clipping to the
    // ball-detection area happens later in _filterHighlightsForObs (dilation + AND).
    // Normal mode: tight nose-line trapezoid (skipping cushion faces and top shadow).

    // Erase baize-hue-but-dark pixels from the top-cushion shadow zone.
    // The shadow cast by the top cushion rail produces pixels that are baize-green
    // in hue (H∈[38,88]) but dark (V<55) with moderate saturation (S>40).  These
    // pixels pass the bitwise_not (they were inside the baize range but only barely,
    // or they were dark enough to fall outside), and can merge a player standing near
    // the top cushion into one giant blob.  Erasing them from nonGreen before contour
    // detection removes the shadow without touching the black ball (S≈0 < 40).
    // Only applied in scan-through mode; restricted to the shadow zone rows.
    if (this.scanThroughObstructions) {
      const frameTopRowS  = Math.round(tl.y * S);
      const shadowRowS    = Math.min(nonGreen.rows, Math.round(shadowY * S));

      if (shadowRowS > frameTopRowS) {
        // Build mask: pixels in shadow zone with H∈[38,88], S>40, V<55
        const loS = new cv.Mat(hsvQ.rows, hsvQ.cols, hsvQ.type(), [38,  40,  0, 0]);
        const hiS = new cv.Mat(hsvQ.rows, hsvQ.cols, hsvQ.type(), [88, 255, 54, 0]);
        let darkBaize = new cv.Mat();
        cv.inRange(hsvQ, loS, hiS, darkBaize);
        loS.delete(); hiS.delete();

        // Zero out shadow zone rows above shadowRowS; keep rest of mask blank
        if (frameTopRowS > 0) {
          const above = darkBaize.roi(new cv.Rect(0, 0, darkBaize.cols, frameTopRowS));
          above.setTo(new cv.Scalar(0));
          above.delete();
        }
        if (shadowRowS < darkBaize.rows) {
          const below = darkBaize.roi(new cv.Rect(0, shadowRowS, darkBaize.cols, darkBaize.rows - shadowRowS));
          below.setTo(new cv.Scalar(0));
          below.delete();
        }

        // Erase matched pixels from nonGreen
        cv.bitwise_not(darkBaize, darkBaize);   // invert: 255 where NOT dark-baize
        cv.bitwise_and(nonGreen, darkBaize, nonGreen);
        darkBaize.delete();
      }
    }
    hsvQ.delete();

    let polyPts;
    if (this.scanThroughObstructions) {
      polyPts = cv.matFromArray(4, 1, cv.CV_32SC2, [
        Math.round(tl.x * S), Math.round(tl.y * S),
        Math.round(tr.x * S), Math.round(tr.y * S),
        Math.round(br.x * S), Math.round(br.y * S),
        Math.round(bl.x * S), Math.round(bl.y * S),
      ]);
    } else {
      polyPts = cv.matFromArray(4, 1, cv.CV_32SC2, [
        Math.round(this.lineX(td.noseLeft,  shadowY)  * S), Math.round(shadowY  * S),
        Math.round(this.lineX(td.noseRight, shadowY)  * S), Math.round(shadowY  * S),
        Math.round(this.lineX(td.noseRight, playBotY) * S), Math.round(playBotY * S),
        Math.round(this.lineX(td.noseLeft,  playBotY) * S), Math.round(playBotY * S),
      ]);
    }
    let polyMask = cv.Mat.zeros(nonGreen.rows, nonGreen.cols, cv.CV_8UC1);
    let mv = new cv.MatVector();
    mv.push_back(polyPts);
    cv.fillPoly(polyMask, mv, new cv.Scalar(255));
    mv.delete(); polyPts.delete();
    cv.bitwise_and(nonGreen, polyMask, nonGreen);
    polyMask.delete();

    // Selectively erase highlight positions from nonGreen.
    // Goal: erase highlights that sit inside ball-dense blobs (so real balls don't
    // register as obstructions), but leave highlights inside obstruction blobs
    // untouched (so the full body — including bright features like ears — stays
    // in nonGreen for contour detection).
    //
    // Heuristic: a blob of N balls has ~N highlights and area ~N × ballArea →
    //   density = highlights / (blobArea / ballArea) ≈ 1.
    // A player body has large area with very few highlights → density << 1.
    // Threshold BALL_HL_DENSITY = 0.4: anything denser than 40% ball-packing is
    // treated as a ball cluster and its highlights are erased.
    //
    // In non-scan-through mode the original behaviour is preserved (erase all).
    const ballAreaQ       = Math.PI * avgEr_q * avgEr_q;  // one ball's area at scale
    const BALL_HL_DENSITY = 0.4;
    const maskR           = Math.max(1, Math.round(avgEr_q * 2));
    const hlList          = highlights || [];

    let ballHighlightIdxs;  // Set of highlight indices to erase

    if (this.scanThroughObstructions && hlList.length > 0) {
      // Preliminary contour pass before any ball masking.
      let nonGreenPre = nonGreen.clone();
      let kPre = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
      cv.morphologyEx(nonGreenPre, nonGreenPre, cv.MORPH_OPEN, kPre);
      kPre.delete();

      let cntrsPre = new cv.MatVector(), hierPre = new cv.Mat();
      cv.findContours(nonGreenPre, cntrsPre, hierPre,
                      cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      hierPre.delete(); nonGreenPre.delete();

      // Pre-compute scaled highlight centre points (ball centre = highlight tip + r)
      const hlPts = hlList.map(h => new cv.Point(
        Math.round(h.hx * S), Math.round(h.hy * S + avgEr_q)));

      ballHighlightIdxs = new Set();
      for (let i = 0; i < cntrsPre.size(); i++) {
        const c          = cntrsPre.get(i);
        const blobArea   = cv.contourArea(c);
        const ballsInBlob = blobArea / ballAreaQ;
        if (ballsInBlob < 0.5) { c.delete(); continue; }  // too small to matter

        const hlInBlob = [];
        for (let j = 0; j < hlList.length; j++) {
          if (cv.pointPolygonTest(c, hlPts[j], false) >= 0) hlInBlob.push(j);
        }

        // Dense enough to be a ball cluster → mark highlights for erasure
        if (hlInBlob.length / ballsInBlob >= BALL_HL_DENSITY) {
          for (const idx of hlInBlob) ballHighlightIdxs.add(idx);
        }
        c.delete();
      }
      cntrsPre.delete();
    } else {
      // Non-scan-through or no highlights: erase all (original behaviour)
      ballHighlightIdxs = new Set(hlList.map((_, j) => j));
    }

    for (let j = 0; j < hlList.length; j++) {
      if (!ballHighlightIdxs.has(j)) continue;
      const h = hlList[j];
      cv.circle(nonGreen,
        new cv.Point(Math.round(h.hx * S), Math.round(h.hy * S + avgEr_q)),
        maskR, new cv.Scalar(0), -1);
    }

    // 3-px open removes residual noise after ball masking
    let kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
    cv.morphologyEx(nonGreen, nonGreen, cv.MORPH_OPEN, kernel);
    kernel.delete();

    let cntrs = new cv.MatVector(), hier = new cv.Mat();
    cv.findContours(nonGreen, cntrs, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    hier.delete(); nonGreen.delete();

    const contours = [];
    let obstructionFound = false, obstructionReason = '';

    for (let i = 0; i < cntrs.size(); i++) {
      const c      = cntrs.get(i);
      const r      = cv.boundingRect(c);
      const maxDim = Math.max(r.width, r.height);
      if (maxDim < 2) { c.delete(); continue; }   // sub-pixel noise

      const mom = cv.moments(c, false);
      const cxQ = mom.m00 > 0 ? mom.m10 / mom.m00 : 0;
      const cyQ = mom.m00 > 0 ? mom.m01 / mom.m00 : 0;

      const nPts = c.rows;
      const step = Math.max(1, Math.floor(nPts / 128));
      const pts  = [];
      for (let j = 0; j < nPts; j += step) {
        pts.push([c.data32S[j * 2] / S, c.data32S[j * 2 + 1] / S]);
      }

      let cls;
      if (maxDim < (avgEr_q*3)) {
        cls = 'small';   // below 1.5x ball width — visible in debug but not an obstruction
      } else {
        const aspect = Math.max(r.width, r.height) / Math.max(1, Math.min(r.width, r.height));
        cls = aspect > 3.0 ? 'cue' : 'obstruction';

        // Ignore blobs that sit almost entirely within the top-cushion shadow zone
        // (from the frame top down to shadowY).  90% threshold: a cue entering from
        // the top cushion will still have its table-end detected.
        const shadowLineS = shadowY * S;
        const fracInShadow = r.height > 0
          ? Math.min(1, Math.max(0, (shadowLineS - r.y) / r.height))
          : 0;
        if (fracInShadow > 0.9) {
          cls = 'small';
        } else if (!obstructionFound) {
          obstructionFound = true;
          obstructionReason = cls === 'cue' ? 'Cue or arm detected on table'
                                            : 'Player or object obstructing table';
        }
      }

      contours.push({
        pts,
        areaFull: cv.contourArea(c) / (S * S),
        cls,
        centroid: { x: cxQ / S, y: cyQ / S },
      });
      c.delete();
    }
    cntrs.delete();

    // ── Blur score (only when clear) ──────────────────────────────────────────
    // Laplacian variance on the playing area at half resolution.  Sharp images
    // produce large variance; blur smears edges and collapses it toward zero.
    let blurScore = null;
    let blurry    = false;
    if ((!obstructionFound || this.scanThroughObstructions) && gray) {
      const roiY0 = Math.max(0, Math.round(tl.y + 0.05 * (bl.y - tl.y)));
      const roiY1 = Math.min(gray.rows - 1, Math.round(bl.y - 0.05 * (bl.y - tl.y)));
      const roiX0 = Math.max(0, Math.round(Math.min(
        this.lineX(td.noseLeft,  roiY0), this.lineX(td.noseLeft,  roiY1))));
      const roiX1 = Math.min(gray.cols - 1, Math.round(Math.max(
        this.lineX(td.noseRight, roiY0), this.lineX(td.noseRight, roiY1))));
      if (roiX1 > roiX0 + 4 && roiY1 > roiY0 + 4) {
        const gRoi = gray.roi(new cv.Rect(roiX0, roiY0, roiX1 - roiX0, roiY1 - roiY0));
        let gSmall = new cv.Mat();
        cv.resize(gRoi, gSmall, new cv.Size(0, 0), 0.5, 0.5, cv.INTER_AREA);
        gRoi.delete();
        let lap = new cv.Mat();
        cv.Laplacian(gSmall, lap, cv.CV_32F);
        let blurTableWidth = gSmall.cols;
        gSmall.delete();
        const mean = new cv.Mat(), stddev = new cv.Mat();
        cv.meanStdDev(lap, mean, stddev);
        blurScore = Math.round(stddev.data64F[0] ** 2);
        mean.delete(); stddev.delete(); lap.delete();
        const blurThresh = 1800 / Math.pow(blurTableWidth / 100, 2.3);
        //console.log("Blur size:", blurTableWidth, blurScore, (blurScore < blurThresh));
        // Hard fail below half threshold; between half and full threshold the
        // table still renders but a "low quality" warning is shown.
        if (blurScore < blurThresh * 0.5) {
          return { suitable: false, reason: 'Video quality too blurry ('+blurScore+')', contours: [], blurScore, blurry: true };
        }
        blurry = blurScore < blurThresh;
      }
    }

    return {
      suitable:        !obstructionFound,
      hasObstruction:  obstructionFound,
      reason:          obstructionFound ? obstructionReason : 'OK',
      contours,
      blurScore,
      blurry,
    };
  }

  // ── Obstruction highlight filter ──────────────────────────────────────────────
  // Removes highlights whose centre falls inside the expanded bounding rect of
  // any obstruction/cue contour.  The expansion radius is OBS_EXPAND_ER times
  // the average ball radius — generous enough to cover cue tips eroded by morph
  // open and holes left by fake highlights on the obstruction surface.
  // Tweak OBS_EXPAND_ER here if the zone is eating too many or too few balls.
  _filterHighlightsForObs(highlights, obsContours, erMid, playAreaCorners, imgW, imgH) {
    const OBS_EXPAND_ER = 0.7;  // ← dilation radius (× ball radius); adjust to taste

    // Work at half resolution to keep the mask small.
    const MS = 0.5;
    const mW = Math.round(imgW * MS);
    const mH = Math.round(imgH * MS);

    // Paint all obstruction contour shapes onto a binary mask.
    let obsMask = cv.Mat.zeros(mH, mW, cv.CV_8UC1);
    for (const c of obsContours) {
      if (c.pts.length < 3) continue;
      const flat = c.pts.flatMap(([x, y]) => [Math.round(x * MS), Math.round(y * MS)]);
      const mat  = cv.matFromArray(c.pts.length, 1, cv.CV_32SC2, flat);
      const mv   = new cv.MatVector();
      mv.push_back(mat);
      cv.fillPoly(obsMask, mv, new cv.Scalar(255));
      mv.delete(); mat.delete();
    }

    // Dilate the mask by OBS_EXPAND_ER × erMid so the contour expands uniformly
    // outward along its actual shape.
    const dilateR = Math.max(1, Math.round(erMid * OBS_EXPAND_ER * MS));
    const kSize   = 2 * dilateR + 1;
    const kernel  = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kSize, kSize));
    cv.dilate(obsMask, obsMask, kernel);
    kernel.delete();

    // Extract debug outline from the dilated shape BEFORE clipping.
    // The post-clip shape follows the playAreaCorners trapezoid boundary which
    // produces confusing zig-zags in the debug overlay.  The pre-clip dilation
    // is a smooth ring around the actual contour, which is what we want to show.
    const debugContours = [];
    {
      let dVec = new cv.MatVector(), dHier = new cv.Mat();
      const obsMaskClone = obsMask.clone();
      cv.findContours(obsMaskClone, dVec, dHier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
      dHier.delete(); obsMaskClone.delete();
      for (let i = 0; i < dVec.size(); i++) {
        const c    = dVec.get(i);
        const nPts = c.rows;
        const step = Math.max(1, Math.floor(nPts / 128));
        const pts  = [];
        for (let j = 0; j < nPts; j += step)
          pts.push([c.data32S[j * 2] / MS, c.data32S[j * 2 + 1] / MS]);
        debugContours.push({ pts });
        c.delete();
      }
      dVec.delete();
    }

    // Clip to the play area (playAreaCorners is already expanded outward from the
    // nose lines by cushionWidth, so balls resting on cushions are included).
    const pac = playAreaCorners;
    const pacFlat = [
      Math.round(pac.tl.x * MS), Math.round(pac.tl.y * MS),
      Math.round(pac.tr.x * MS), Math.round(pac.tr.y * MS),
      Math.round(pac.br.x * MS), Math.round(pac.br.y * MS),
      Math.round(pac.bl.x * MS), Math.round(pac.bl.y * MS),
    ];
    let playMask = cv.Mat.zeros(mH, mW, cv.CV_8UC1);
    const pacMat = cv.matFromArray(4, 1, cv.CV_32SC2, pacFlat);
    const mv2    = new cv.MatVector();
    mv2.push_back(pacMat);
    cv.fillPoly(playMask, mv2, new cv.Scalar(255));
    mv2.delete(); pacMat.delete();
    cv.bitwise_and(obsMask, playMask, obsMask);
    playMask.delete();

    // Filter highlights whose centre falls inside the dilated+clipped zone.
    const filtered = highlights.filter(h => {
      const px = Math.max(0, Math.min(mW - 1, Math.round(h.hx * MS)));
      const py = Math.max(0, Math.min(mH - 1, Math.round(h.hy * MS)));
      return obsMask.ucharAt(py, px) === 0;
    });

    // Extract the clipped polygon for mm mapping (drives plan-view shadow).
    // The clipped shape accurately represents what's excluded from the table.
    let cVec = new cv.MatVector(), hier = new cv.Mat();
    cv.findContours(obsMask, cVec, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
    hier.delete(); obsMask.delete();

    const expandedContours = [];
    for (let i = 0; i < cVec.size(); i++) {
      const c    = cVec.get(i);
      const nPts = c.rows;
      const step = Math.max(1, Math.floor(nPts / 128));
      const pts  = [];
      for (let j = 0; j < nPts; j += step)
        pts.push([c.data32S[j * 2] / MS, c.data32S[j * 2 + 1] / MS]);
      expandedContours.push({ pts });
      c.delete();
    }
    cVec.delete();

    return { filtered, expandedContours, debugContours };
  }

  // ── Main ──────────────────────────────────────────────────────────────────────
  detect() {
    if (!this.srcMat) return;

    let rgb = new cv.Mat(), hsv = new cv.Mat(), gray = new cv.Mat();
    try {
    cv.cvtColor(this.srcMat, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);

	let p = [];


    const tRect      = this.findTable(this.srcMat);

    if (!tRect) {
	  // TODO tell UI we can't find the table
      return;
    }

    const tableLines = this.detectTableEdgeLines(this.srcMat, tRect, hsv, gray);




    // ── Expose line data globally for external calculation ──────────────────
    if (tableLines) {
      this.tableData = {
        // Named frame edges
        frameTop:    tableLines.frame[0],  // {x1,y1,x2,y2}  TL→TR
        frameBot:    tableLines.frame[1],  // {x1,y1,x2,y2}  BL→BR
        frameLeft:   tableLines.frame[2],  // {x1,y1,x2,y2}  TL→BL
        frameRight:  tableLines.frame[3],  // {x1,y1,x2,y2}  TR→BR
        // Orange cushion inner edges
        playAreaLeft:  tableLines.playArea[0],  // {x1,y1,x2,y2} TL->BL
        playAreaRight: tableLines.playArea[1],  // {x1,y1,x2,y2} TR->BR
        // Corner intersections
        corners: tableLines.corners,        // {tl,tr,bl,br} each {x,y}
      };
  	tableLines.playAreaCorners = this.calcCushionLines();
      this.tableData.playAreaCorners = tableLines.playAreaCorners;
  	tableLines.playArea[0] = {x1:tableLines.playAreaCorners.tl.x,y1:tableLines.playAreaCorners.tl.y,x2:tableLines.playAreaCorners.tr.x,y2:tableLines.playAreaCorners.tr.y};  // {x1,y1,x2,y2} TL->TR
  	tableLines.playArea[1] = {x1:tableLines.playAreaCorners.bl.x,y1:tableLines.playAreaCorners.bl.y,x2:tableLines.playAreaCorners.br.x,y2:tableLines.playAreaCorners.br.y};  // {x1,y1,x2,y2} BL->BR
  	tableLines.playArea[2] = {x1:tableLines.playAreaCorners.tl.x,y1:tableLines.playAreaCorners.tl.y,x2:tableLines.playAreaCorners.bl.x,y2:tableLines.playAreaCorners.bl.y};  // {x1,y1,x2,y2} TL->BL
  	tableLines.playArea[3] = {x1:tableLines.playAreaCorners.tr.x,y1:tableLines.playAreaCorners.tr.y,x2:tableLines.playAreaCorners.br.x,y2:tableLines.playAreaCorners.br.y};  // {x1,y1,x2,y2} TR->BR

    }
  
    // Find expected ball width at various latitudes
    this.tableData.ballSizes  = {};
    this.tableData.viewAngles = {};
    const yStep   = (tableLines.corners.bl.y - tableLines.corners.tl.y) / 50;
    for (var i = tableLines.corners.tl.y; i < tableLines.corners.bl.y; i += yStep) {
      const yi = Math.round(i);
      const leftX  = this.lineX(this.tableData.noseLeft,  i);
      const rightX = this.lineX(this.tableData.noseRight, i);
      const ballWidthPx = this.ballWidth * (rightX - leftX) / this.tableWidth;
      this.tableData.ballSizes[yi]     = ballWidthPx;
      this.tableData.largestBallSizePx = ballWidthPx;
    }

    // Precompute cumulative y_mm integral for pixelToTableMm.
    //
    // Derivation: y_scale = D²/(focalPx·H) = focalPx·tableWidth²/(H·W²) = K·tableWidth²/W²
    // where K = focalPx/H is unknown but can be solved by normalising:
    //   K·tableWidth²·∫(1/W²)dy = expectedSpan  →  K = expectedSpan/(tableWidth²·rawTotal)
    //
    // This requires only the nose lines — no camera-model parameters.
    if (this.tableData.noseLeft && this.tableData.noseRight &&
        this.tableData.cushionWidth !== undefined) {
      const tl_y = tableLines.corners.tl.y, bl_y = tableLines.corners.bl.y;
      const iRows = [], rawVals = [];
      let raw = 0, prevRow = tl_y;
      let prevW = this.lineX(this.tableData.noseRight, tl_y) - this.lineX(this.tableData.noseLeft, tl_y);
      iRows.push(Math.round(tl_y)); rawVals.push(0);
      for (var i = tl_y + yStep; i <= bl_y + yStep * 0.5; i += yStep) {
        const ii = Math.min(i, bl_y);
        const W1 = this.lineX(this.tableData.noseRight, ii) - this.lineX(this.tableData.noseLeft, ii);
        const s0 = prevW > 0 ? 1 / (prevW * prevW) : 0;
        const s1 = W1    > 0 ? 1 / (W1    * W1)    : 0;
        raw += (s0 + s1) / 2 * (ii - prevRow);
        iRows.push(Math.round(ii)); rawVals.push(raw);
        prevRow = ii; prevW = W1;
        if (ii >= bl_y) break;
      }
      // Scale so total = tableHeight + 2×cushionWidth (frame-top → frame-bottom span)
      const expectedSpan = this.tableHeight + 2 * this.tableData.cushionWidth;
      const scale = raw > 0 ? expectedSpan / raw : 1;
      const iVals = rawVals.map(v => v * scale);
      this.tableData.yIntegral = { rows: iRows, vals: iVals };

      // Viewing angle at each row, derived directly from the width profile.
      //
      // For a pinhole camera at height H with focal length f, the pixel width of
      // a ground object of real width W_real at viewing angle ψ (from horizontal) is:
      //   W(y) = f · W_real · sin(ψ) / H   (approximation: cos(ψ−φ) ≈ 1 near the
      //           optical axis, which holds well for broadcast snooker angles)
      //
      // The yIntegral normalisation gives K = f/H = scale / tableWidth²,
      // so: sin(ψ(y)) = W(y) · tableWidth / scale  (no vanishing points needed).
      for (var i = tl_y; i < bl_y; i += yStep) {
        const yi  = Math.round(i);
        const W   = this.lineX(this.tableData.noseRight, i) - this.lineX(this.tableData.noseLeft, i);
        const sinPsi = Math.min(1, W * this.tableWidth / scale);
        if (sinPsi > 0.017) {   // > ~1°
          const psiDeg = Math.asin(sinPsi) * 180 / Math.PI;
          if (psiDeg < 89) this.tableData.viewAngles[yi] = psiDeg;
        }
      }
    }

    const corners = tableLines?.playAreaCorners || tableLines?.corners || null;

    const cueDebug = this.detectCueLines(hsv);

    // Compute exclusion geometry: a band of 10% ball-diam each side of every
    // detected line, plus filled quads between any two nearly-parallel lines
    // that are within 20% ball-diam of each other (the cue body cross-section).
    {
      const refY       = Math.round((tableLines.corners.tl.y + tableLines.corners.bl.y) / 2);
      const ballDiamPx = this.tableData.ballSizes[refY] || 30;
      const bandHalf   = Math.max(1, Math.round(ballDiamPx * 0.20));
      const pairGap    = ballDiamPx * 0.20;

      cueDebug.exclusionBands = cueDebug.cueLines.map(l => ({ ...l, halfW: bandHalf }));
      cueDebug.exclusionFills = [];

      const ls = cueDebug.cueLines;
      for (let i = 0; i < ls.length; i++) {
        for (let j = i + 1; j < ls.length; j++) {
          const a = ls[i], b = ls[j];
          let dAng = Math.abs(Math.atan2(a.y2 - a.y1, a.x2 - a.x1) -
                              Math.atan2(b.y2 - b.y1, b.x2 - b.x1));
          if (dAng > Math.PI / 2) dAng = Math.PI - dAng;
          if (dAng > 20 * Math.PI / 180) continue;
          const dx = a.x2 - a.x1, dy = a.y2 - a.y1, aLen = Math.hypot(dx, dy);
          if (aLen < 1) continue;
          const mx = (b.x1 + b.x2) / 2, my = (b.y1 + b.y2) / 2;
          const dist = Math.abs((my - a.y1) * dx - (mx - a.x1) * dy) / aLen;
          if (dist > pairGap) continue;
          cueDebug.exclusionFills.push([
            { x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 },
            { x: b.x2, y: b.y2 }, { x: b.x1, y: b.y1 },
          ]);
        }
      }

      // Apply exclusion mask to a clone of gray so the original is untouched
      // for checkTableClear's blur computation.
      if (cueDebug.exclusionBands.length > 0) {
        const cueMask = new cv.Mat(gray.rows, gray.cols, cv.CV_8U, [255, 0, 0, 0]);
        for (const b of cueDebug.exclusionBands) {
          cv.line(cueMask,
            { x: Math.round(b.x1), y: Math.round(b.y1) },
            { x: Math.round(b.x2), y: Math.round(b.y2) },
            [0, 0, 0, 0], Math.max(1, b.halfW * 2 + 1));
        }
        for (const fill of cueDebug.exclusionFills) {
          const pts = cv.matFromArray(fill.length, 1, cv.CV_32SC2,
            fill.flatMap(p => [Math.round(p.x), Math.round(p.y)]));
          const pv = new cv.MatVector();
          pv.push_back(pts);
          cv.fillPoly(cueMask, pv, [0, 0, 0, 0]);
          pv.delete(); pts.delete();
        }
        const maskedGray = gray.clone();
        cv.bitwise_and(maskedGray, cueMask, maskedGray);
        cueMask.delete();
        var grayForHighlights = maskedGray;
      } else {
        var grayForHighlights = gray;
      }
    }

    // Highlights needed before clearCheck so ball positions can be masked out.
    const highlights = this.detectHighlights(grayForHighlights, tRect, corners);
    if (grayForHighlights !== gray) grayForHighlights.delete();

    // Table-clear check: geometry + non-green blob analysis (quarter scale).
    // Balls are pre-masked via highlight positions, so a cluster of reds won't fire.
    this.tableData.clearCheck = this.checkTableClear(rgb, highlights, gray);
    const cc = this.tableData.clearCheck;

    // Hard stop: geometry or blur failure — cannot reliably detect anything.
    // Obstruction-only failures are handled below (scan-through mode).
    const hardStop = !cc.suitable && !cc.hasObstruction;
    if (hardStop || this.checkOnly) {
      this.detections = [];
      this.debugInfo = {
        clearCheck:    cc,
        imgWidth:      this.srcMat.cols,
        imgHeight:     this.srcMat.rows,
        tRect:         tRect ? { x: tRect.x, y: tRect.y, w: tRect.width, h: tRect.height } : null,
        tableLines:    tableLines ? {
          frame: tableLines.frame, playArea: tableLines.playArea,
          corners: tableLines.corners, playAreaCorners: tableLines.playAreaCorners,
        } : null,
        highlights:    highlights.map(h => ({ hx: h.hx, hy: h.hy, hr: h.hr, large: h.large })),
        rawDetections: [], arcDebug: [], sideDebug: [],
        cueDebug,
        obsRegionsMm: [], obsDebugContours: [],
      };
      return;
    }

    // If there are obstructions and scan-through is enabled, filter highlights
    // that fall inside the expanded obstruction zone so they don't generate
    // spurious ball detections.
    const obsContours = cc.contours.filter(c => c.cls === 'obstruction' || c.cls === 'cue');
    const midY  = (tRect.y + tRect.y + tRect.height) / 2;
    const erMid = this.lookupR(midY, tRect.y, tRect.y + tRect.height);
    let scanHighlights      = highlights;
    let obsExpandedContours = [];   // clipped — used only for highlight pixel test
    let obsDebugContours    = [];   // pre-clip dilation — debug overlay + plan shadow
    if (obsContours.length > 0 && this.scanThroughObstructions) {
      const pac = this.tableData.playAreaCorners;
      const filterResult = this._filterHighlightsForObs(
        highlights, obsContours, erMid, pac,
        this.srcMat.cols, this.srcMat.rows,
      );
      scanHighlights      = filterResult.filtered;
      obsExpandedContours = filterResult.expandedContours;
      obsDebugContours    = filterResult.debugContours;
    }

    let circles = this.detectContours(gray, hsv, scanHighlights, tRect, corners);
    let dets = this.adjustSidePositions(circles, hsv, highlights, tRect);
    let { detections, mDx, mDy } = this.pairAndCorrect(dets, highlights);

    for (const d of detections) {
      d.colour = this.identifyColour(hsv, d.cx, d.cy, d.r, d.highlight,
        detections.filter(o => o !== d));
      d.topX   = Math.round(d.cx);
      d.topY   = Math.round(d.cy - d.r);
    }

    detections = this._filterSpuriousGreen(detections, gray);
    detections = this._rescueWhite(detections, hsv);
    detections = this.dedupSingles(detections, hsv);
    detections = this._rescueBrown(detections, hsv);

    // Map pixel-space detections to mm on the playing surface via the
    // cushion-fraction + log-integral mapping.  Perspective is only used for the
    // small ball-top-height correction (~16.5 mm above the cushion-nose plane).
    const td = this.tableData;
    if (td.noseLeft && td.noseRight && td.cushionWidth !== undefined) {
      // topY = cy - r is the image row of the ball-top silhouette point, which lies
      // at 3D position (x, y_ball − R·cosθ, R·(1+sinθ)).  pixelToTableMm maps that
      // to the z=35mm reference plane, giving:
      //   pos.y = y_ball − R·(1+sinθ)/cosθ + 35·tanθ
      // Inverting:  y_ball = pos.y + R·(1+sinθ)/cosθ − 35·tanθ
      // For our angle range (22–31°) the two θ-terms nearly cancel and the
      // correction ≈ +R = ballWidth/2 with < 2mm residual error.
      const R = this.ballWidth / 2;   // ball radius ≈ 25.75 mm
      this.detections = detections.map(d => {
        const pos     = this.pixelToTableMm(d.topX, d.topY);
        const tiltRad = this.lookupAngle(d.topY) * Math.PI / 180;
        const sinT = Math.sin(tiltRad), cosT = Math.cos(tiltRad);
        const yCorr = cosT > 0.05
          ? R * (1 + sinT) / cosT - 35 * sinT / cosT
          : R;
        return {
          x:      pos.x,
          y:      pos.y + yCorr,
          colour: d.colour.swatch,
        };
      });
    } else {
      this.detections = [];
    }

    // Map the pre-clip dilation contours to mm for plan-view shading —
    // same shape as the debug outline, so plan shadow matches what's shown.
    const obsRegionsMm = obsDebugContours.map(c => ({
      ptsMm: c.pts.map(([px, py]) => {
        const mm = this.pixelToTableMm(px, py);
        return {
          x: Math.max(-this.tableWidth  * 0.1, Math.min(this.tableWidth  * 1.1, mm.x)),
          y: Math.max(-this.tableHeight * 0.1, Math.min(this.tableHeight * 1.1, mm.y)),
        };
      }),
    }));

    // Snapshot everything needed for the overlay debug canvas.
    this.debugInfo = {
      clearCheck: this.tableData.clearCheck,
      imgWidth:  this.srcMat.cols,
      imgHeight: this.srcMat.rows,
      tRect:     tRect ? { x: tRect.x, y: tRect.y, w: tRect.width, h: tRect.height } : null,
      tableLines: tableLines ? {
        frame:           tableLines.frame,
        playArea:        tableLines.playArea,
        corners:         tableLines.corners,
        playAreaCorners: tableLines.playAreaCorners,
      } : null,
      highlights: highlights.map(h => ({ hx: h.hx, hy: h.hy, hr: h.hr, large: h.large })),
      rawDetections: detections.map(d => ({
        cx: d.cx, cy: d.cy, r: d.r,
        topX: d.topX, topY: d.topY,
        swatch: d.colour.swatch,
        name:   d.colour.name,
        adjusted: !!d.adjusted, recovered: !!d.recovered,
      })),
      arcDebug:  this._arcDebug  || [],
      sideDebug: this._sideDebug || [],
      cueDebug,
      obsRegionsMm,
      obsDebugContours,
    };

    } finally {
      // Always free WASM heap regardless of how detect() exits.
      // srcMat is owned by this call (created in constructor immediately before
      // detect()); release it here so it doesn't outlive the scan.
      rgb.delete(); hsv.delete(); gray.delete();
      if (this.srcMat) { this.srcMat.delete(); this.srcMat = null; }
    }
  }

}
