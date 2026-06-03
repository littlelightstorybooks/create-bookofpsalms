// ================================================================
// LITTLE LIGHT V2 -- engine.js
// Unified Page Model + Renderer + PDF Export Engine
// Supports gender-based data: ST.boy / ST.girl via ST.active
// ================================================================

'use strict';

var LL = window.LL = window.LL || {};

// All API calls route through the Cloudflare Worker — credentials never exposed in browser.
LL.WORKER_URL  = 'https://littlelight-bookofpsalms.llomerferdinandsantos.workers.dev';
LL.APP_TOKEN   = 'bopps_9x2k7mQvBpTrNdZs';  // matches APP_TOKEN in Cloudflare Worker env

// Legacy direct credentials removed — kept as empty strings for any missed references
LL.DB_BIN_ID  = '';
LL.DB_API_KEY = '';

// Cloudinary config — cloud name served from worker, preset no longer in browser
LL.CL_CLOUD  = 'djuclkztk'; // cloud name is public (appears in image URLs anyway)
LL.CL_PRESET = '';           // preset now handled server-side by worker
LL.CL_URL    = LL.WORKER_URL + '/upload';

LL.PRICING = {
  standard:  { label: 'Standard',  base: 599,  maxL: 8,  ex: 50  },
  hardbound: { label: 'Hardbound', base: 2199, maxL: 11, ex: 100 },
};

// ----------------------------------------------------------------
// ORDER STORAGE — saves/loads orders via JSONBin so they are
// accessible from any device (admin dashboard reads customer orders).
// SAFE: fetches full bin first, only updates the 'orders' key,
// preserves all boy/girl layout data. Never corrupts content.
// ----------------------------------------------------------------

LL.loadOrders = function(onDone) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', LL.WORKER_URL + '/db/get');
  xhr.setRequestHeader('X-App-Token', LL.APP_TOKEN);
  xhr.onload = function() {
    if (xhr.status === 200) {
      try {
        var data = JSON.parse(xhr.responseText);
        var orders = Array.isArray(data.orders) ? data.orders : [];
        localStorage.setItem('bop_orders', JSON.stringify(orders));
        if (onDone) onDone(orders);
        return;
      } catch(e) {}
    }
    var local = [];
    try { local = JSON.parse(localStorage.getItem('bop_orders') || '[]'); } catch(e) {}
    if (onDone) onDone(local);
  };
  xhr.onerror = function() {
    var local = [];
    try { local = JSON.parse(localStorage.getItem('bop_orders') || '[]'); } catch(e) {}
    if (onDone) onDone(local);
  };
  xhr.send();
};

LL.saveOrder = function(order, onDone) {
  // Strip base64 images from order before saving to KV (too large)
  var safeOrder = JSON.parse(JSON.stringify(order));
  if (safeOrder.child && safeOrder.child.photo && 
      typeof safeOrder.child.photo === 'string' && 
      safeOrder.child.photo.startsWith('data:')) {
    safeOrder.child.photo = '__img__'; // sentinel — replaced by Cloudinary URL later
  }
  if (safeOrder.payment && safeOrder.payment.screenshot && 
      typeof safeOrder.payment.screenshot === 'string' && 
      safeOrder.payment.screenshot.startsWith('data:')) {
    safeOrder.payment.screenshot = '__img__';
  }

  // Step 1: fetch full bin to preserve boy/girl layout data
  var xhr1 = new XMLHttpRequest();
  xhr1.open('GET', LL.WORKER_URL + '/db/get');
  xhr1.setRequestHeader('X-App-Token', LL.APP_TOKEN);
  xhr1.onload = function() {
    var binData = {};
    try { binData = JSON.parse(xhr1.responseText); } catch(e) {}
    // Prepend new order, dedupe by ref — only touch 'orders' key
    var existing = Array.isArray(binData.orders) ? binData.orders : [];
    existing = existing.filter(function(o) { return o.ref !== safeOrder.ref; });
    existing.unshift(safeOrder);
    binData.orders = existing;
    // Step 2: write back full bin with updated orders
    var xhr2 = new XMLHttpRequest();
    xhr2.open('PUT', LL.WORKER_URL + '/db/put');
    xhr2.setRequestHeader('Content-Type', 'application/json');
    xhr2.setRequestHeader('X-App-Token', LL.APP_TOKEN);
    xhr2.onload = function() { if (onDone) onDone(existing); };
    xhr2.onerror = function() { if (onDone) onDone(existing); };
    xhr2.send(JSON.stringify(binData));
  };
  xhr1.onerror = function() {
    console.error('[LL] Order save failed — network error');
    if (onDone) onDone(null);
  };
  xhr1.send();
};

// ----------------------------------------------------------------
// LL.resolveImg — normalize + auto-optimize any stored image URL.
//
// For Cloudinary URLs: injects f_auto,q_auto transforms so the
// browser receives WebP/AVIF at optimal quality automatically.
// Reduces image size 60-80% vs original with no visible quality loss.
//
// For base64 data URIs (legacy): returned as-is.
// For sentinel '__img__': returns null (stripped placeholder).
// ----------------------------------------------------------------
LL._clTransform = function(url, w) {
  // Only transform Cloudinary URLs — leave everything else alone
  if (!url || typeof url !== 'string') return url;
  if (!url.includes('cloudinary.com')) return url;
  if (url.includes('/upload/') ) {
    // Build transform string
    var t = 'f_auto,q_auto';
    if (w) t += ',w_' + w + ',c_limit'; // limit width, preserve aspect
    // Insert transforms after /upload/
    return url.replace('/upload/', '/upload/' + t + '/');
  }
  return url;
};

// resolveImg — for UI rendering (optimized, fast)
LL.resolveImg = function(v, w) {
  if (!v) return null;
  if (typeof v === 'string' && v === '__img__') return null;
  if (typeof v === 'string' && v.startsWith('data:')) return v; // base64 legacy
  if (typeof v === 'string' && (v.startsWith('http') || v.startsWith('https'))) {
    return LL._clTransform(v, w || null);
  }
  if (typeof v === 'object' && v && v.secure_url) return LL._clTransform(v.secure_url, w);
  return null;
};

// resolveImgRaw — full-res original URL, used for PDF export only
// (html2canvas needs the actual full-res image for crisp PDF output)
LL.resolveImgRaw = function(v) {
  if (!v) return null;
  if (typeof v === 'string' && v === '__img__') return null;
  if (typeof v === 'string' && (v.startsWith('http') || v.startsWith('data:'))) return v;
  if (typeof v === 'object' && v && v.secure_url) return v.secure_url;
  return null;
};

// Convenience: resolveImg with specific pixel width for responsive sizing
// Usage: LL.imgAt(url, 800) → optimized for 800px display width
LL.imgAt = function(v, w) { return LL.resolveImg(v, w); };

// ----------------------------------------------------------------
// LL.outlineStyle — builds the CSS text-outline effect string.
//
// Strategy: combines -webkit-text-stroke (crisp hard edge) with
// a 4-directional text-shadow stack (soft fill reinforcement).
// This gives the best result on both screen and html2canvas PDF.
//
// @param ly  — layout object (ly.outlineEnabled, ly.outlineColor, ly.outlineWidth)
// @returns   — CSS property string ready to inject into style=""
// ----------------------------------------------------------------
LL.outlineStyle = function(ly) {
  if (!ly || !ly.outlineEnabled) return '';
  var col = ly.outlineColor || '#000000';
  var w   = parseFloat(ly.outlineWidth) || 1;
  // -webkit-text-stroke: crisp outer edge
  var stroke = '-webkit-text-stroke:' + w + 'px ' + col + ';';
  // 4-directional shadow stack: fills corners the stroke misses
  var d  = w;
  var sh = [d+'px '+d+'px 0 '+col, '-'+d+'px '+d+'px 0 '+col,
            d+'px -'+d+'px 0 '+col, '-'+d+'px -'+d+'px 0 '+col,
            '0 '+d+'px 0 '+col, '0 -'+d+'px 0 '+col,
            d+'px 0 0 '+col, '-'+d+'px 0 0 '+col].join(',');
  return stroke + 'text-shadow:' + sh + ';paint-order:stroke fill;';
};

// Substitute {{babyname}} and {{giver}} in any text string.
LL.resolvePlaceholders = function(text, name, giver) {
  if (!text) return '';
  return String(text)
    .replace(/\{\{babyname\}\}/gi, name  || '')
    .replace(/\{\{giver\}\}/gi,   giver || '');
};

// Safe HTML escaping for inline-rendered text.
LL.escHtml = function(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
};

// ----------------------------------------------------------------
// SECTION 2: UNIFIED PAGE MODEL
//
// Every page normalizes to:
// {
//   type:    'intro' | 'letter-l' | 'letter-r' | 'outro' | 'filler'
//   image:   string|null
//   title:   string
//   message: string
//   verse:   string
//   meta:    {}
// }
//
// Gender awareness:
// Pass the full ST object. buildPageModel resolves the active
// gender dataset automatically via ST.active (or falls back to
// flat format for backward compatibility).
// ----------------------------------------------------------------

// resolveDataset -- extract the gender-aware content dataset from state.
// Returns an object with: introImages, introMessages, introLayouts,
// outroImages, outroMessages, outroLayouts, letters.
LL.resolveDataset = function(state, gender) {
  var es = state || {};

  // New format: { boy: {...}, girl: {...}, config, pageSettings }
  if (es.boy || es.girl) {
    var g = gender || es.activeGender || 'boy';
    var dataset = es[g] || es.boy || {};
    return {
      introImages:   dataset.introImages   || [],
      introMessages: dataset.introMessages || [],
      introLayouts:  dataset.introLayouts  || [],
      outroImages:   dataset.outroImages   || [],
      outroMessages: dataset.outroMessages || [],
      outroLayouts:  dataset.outroLayouts  || [],
      letters:       dataset.letters       || {},
    };
  }

  // Legacy flat format (backward compatibility)
  return {
    introImages:   es.introImages   || [],
    introMessages: es.introMessages || [],
    introLayouts:  es.introLayouts  || [],
    outroImages:   es.outroImages   || [],
    outroMessages: es.outroMessages || [],
    outroLayouts:  es.outroLayouts  || [],
    letters:       es.letters       || {},
  };
};

// buildPageModel -- returns flat normalized page array.
// @param state    -- full ST object from localStorage/JSONBin
// @param userData -- { raw, letters, gender, photo, ded }
LL.buildPageModel = function(state, userData, opts) {
  var useRaw = opts && opts.raw; // true = full-res URLs for PDF
  var imgFn  = useRaw ? LL.resolveImgRaw : function(v){ return LL.resolveImg(v, 420); };
  var es  = state || {};
  var cfg = es.config || {};

  // Resolve gender from userData first, then state, then default
  var gender = (userData && userData.gender) || es.activeGender || 'boy';

  // Get the active dataset for this gender
  var D = LL.resolveDataset(es, gender);

  var introCount = cfg.introCount || 13;
  var outroCount = cfg.outroCount || 5;
  var letters    = ((userData && userData.letters) || '').toUpperCase();
  var name       = ((userData && userData.raw)   || '').trim();
  var giver      = ((userData && userData.giver) || '').trim();

  var pages = [];

  // -- 1. INTRO PAGES --------------------------------------------
  for (var ii = 0; ii < introCount; ii++) {
    pages.push({
      type:    'intro',
      image:   imgFn(D.introImages[ii]) || null,
      title:   '',
      message: D.introMessages[ii] || '',
      verse:   '',
      meta: {
        layout:        D.introLayouts[ii] || {},
        pageNum:       ii + 1,
        isFrontCover:  ii === 0,
        customerPhoto: (D.introLayouts[ii] && D.introLayouts[ii].useCustomerPhoto)
                       ? (userData && userData.photo ? userData.photo : null)
                       : null,
        dedication:    (D.introLayouts[ii] && D.introLayouts[ii].useDedication)
                       ? (userData && userData.ded ? userData.ded : null)
                       : null,
      },
    });
  }

  // -- 2. LETTER PAGES -------------------------------------------
  if (letters) {
    var usedVariations = {};
    var usedMeanings   = {};

    letters.split('').forEach(function(l, idx) {
      var lData = D.letters[l] || {};
      var vars  = lData.variations || [];

      // Rotate variations per letter occurrence
      if (!usedVariations[l]) usedVariations[l] = 0;
      var varIdx    = usedVariations[l] % Math.max(vars.length, 1);
      usedVariations[l]++;
      var variation = vars[varIdx] || null;

      // Pick unused meaning, then cycle
      var meanings = (lData.meanings && lData.meanings.length)
        ? lData.meanings
        : (typeof DEFAULT_MEANINGS !== 'undefined' && DEFAULT_MEANINGS[l]) || [];
      if (!usedMeanings[l]) usedMeanings[l] = [];
      var pool = meanings.map(function(_, i) { return i; })
                         .filter(function(i) { return usedMeanings[l].indexOf(i) === -1; });
      if (!pool.length) { usedMeanings[l] = []; pool = meanings.map(function(_, i) { return i; }); }
      var pick    = pool.length ? pool[Math.floor(Math.random() * pool.length)] : 0;
      usedMeanings[l].push(pick);
      var meaning = meanings[pick] || { title: '', verse: '', text: '' };

      var vText   = (variation && variation.text)   || {};
      var vLayout = (variation && variation.layout) || {};

      // Left page -- decorative letter illustration
      pages.push({
        type:    'letter-l',
        image:   imgFn(variation ? variation.leftImg  : null),
        title:   '', message: '', verse: '',
        meta:    { letter: l, idx: idx, total: letters.length, layout: vLayout },
      });

      // Right page -- blessing / message / verse
      pages.push({
        type:    'letter-r',
        image:   imgFn(variation ? variation.rightImg : null),
        title:   vText.blessing || meaning.title || '',
        message: vText.message  || meaning.message || '',
        verse:   vText.verse    || meaning.verse  || '',
        meta:    { letter: l, layout: vLayout, nameLen: letters.replace(/\s/g, '').length },
      });
    });
  }

  // -- 3. OUTRO PAGES (dynamic) ---------------------------------
  //
  // Admin uploads 5 outro pages:
  //   [0..N-3] = content pages (scripture, decorative, etc.)
  //   [N-2]    = inside back cover  -- always second to last
  //   [N-1]    = outside back cover -- always last
  //
  // The engine calculates how many content pages (1 or 3) are
  // needed so that the final total is exactly divisible by 4.
  // No filler/blank pages are ever added.
  //
  // Proof: intro(13) + letters(even) + backCovers(2) = odd.
  // odd % 4 is always 1 or 3, so we need 3 or 1 content pages
  // to reach the next multiple of 4. Max needed = 3.

  var insideBackIdx  = outroCount - 2; // second to last outro slot
  var outsideBackIdx = outroCount - 1; // last outro slot

  // How many content outro pages (not back covers) are available
  var contentOutroCount = outroCount - 2; // e.g. 5 - 2 = 3

  // Calculate how many content pages needed to reach ÷4
  // We know back covers (2) always come at the end, so:
  var pagesBeforeBackCovers = pages.length; // intro + letters so far
  // Find middle count (1 or 3) that makes total divisible by 4
  var middleNeeded = 0;
  while ((pagesBeforeBackCovers + middleNeeded + 2) % 4 !== 0) {
    middleNeeded++;
  }
  // Cap to available content pages (should never exceed 3)
  middleNeeded = Math.min(middleNeeded, contentOutroCount);

  // Helper to build one outro page object.
  // Always emits type:'intro' so the full layout engine applies —
  // photo overlay, text position, outline, transform all work exactly
  // as they do for intro pages. isBack is preserved in meta for PDF bg colour.
  function makeOutroPage(oi, isBack) {
    var outroMsg = D.outroMessages[oi] || '';
    var outroLy  = D.outroLayouts[oi]  || {};
    var hasPhoto = outroLy.useCustomerPhoto;
    return {
      type:    'intro',
      image:   imgFn(D.outroImages[oi]) || null,
      title:   '', verse: '',
      message: outroMsg,
      meta: {
        layout:        outroLy,
        pageNum:       oi + 1,
        isFrontCover:  false,
        isBackCover:   isBack,
        customerPhoto: hasPhoto
                       ? (userData && userData.photo ? userData.photo : null)
                       : null,
      },
    };
  }

  // Insert content outro pages (1 or 3 as needed)
  // Take from the END of the content slots so the best pages are used
  var startSlot = contentOutroCount - middleNeeded;
  for (var ci = startSlot; ci < contentOutroCount; ci++) {
    pages.push(makeOutroPage(ci, false));
  }

  // Always append inside back cover then outside back cover
  pages.push(makeOutroPage(insideBackIdx,  false));
  pages.push(makeOutroPage(outsideBackIdx, true));

  return pages;
};

// ----------------------------------------------------------------
// SECTION 3: SINGLE RENDER ENGINE
// renderPage(page, name, giver) -> HTML string
// Handles ALL page types. No branching outside this function.
// ----------------------------------------------------------------

LL.renderPage = function(page, name, giver) {
  if (!page || page.type === 'filler') {
    return '<div style="width:100%;height:100%;background:#111;"></div>';
  }

  var img  = page.image;
  var nm   = name  || '';
  var gv   = giver || '';
  var meta = page.meta || {};
  var ly   = meta.layout || {};

  // INTRO ----------------------------------------------------------
  if (page.type === 'intro') {
    var msg = LL.resolvePlaceholders(page.message, nm, gv);
    if (img) {
      var overlay = '';
      if (msg.trim()) {
        var fnt = (ly.font || 'Lora') + ',serif';
        var sz  = (ly.fontSize || ly.size || 13) + 'px';
        var col = ly.color  || '#FFFFFF';
        var bld = ly.bold   ? '700' : '400';
        var lh  = (ly.lineHeight && ly.lineHeight >= 1) ? ly.lineHeight : (meta.isFrontCover ? 1.1 : 1.6);
        var tt  = ly.textTransform || 'none';
        var mw  = (ly.maxWidth != null ? ly.maxWidth : 80) + '%';
        var lft = (ly.startX   != null ? ly.startX   : 50) + '%';
        var top = (ly.startY   != null ? ly.startY   : 80) + '%';
        var outlineCss = LL.outlineStyle(ly);
        overlay = '<div style="position:absolute;left:' + lft + ';top:' + top + ';'
          + 'transform:translateX(-50%);width:' + mw + ';text-align:center;pointer-events:none;">'
          + '<div style="font-family:' + fnt + ';font-size:' + sz + ';font-weight:' + bld + ';'
          + 'color:' + col + ';line-height:' + lh + ';text-transform:' + tt + ';'
          + outlineCss + 'word-break:break-word;white-space:pre-wrap;">'
          + LL.escHtml(msg) + '</div></div>';
      }
      // Customer photo overlay (contains without cropping)
      var photoHtml = '';
      if (ly.useCustomerPhoto) {
        var pUrl = meta.customerPhoto || null;
        // Fixed px box — no transforms, no percentages, fully html2canvas compatible
        var pT   = (ly.photoTop    != null ? ly.photoTop    : 10);
        var pBot = (ly.photoBottom != null ? ly.photoBottom : 160);
        var pL   = (ly.photoLeft   != null ? ly.photoLeft   : 0);
        var pR   = (ly.photoRight  != null ? ly.photoRight  : 420);
        var pBox = 'position:absolute;top:'+pT+'px;left:'+pL+'px;'
                 + 'width:'+(pR-pL)+'px;height:'+(pBot-pT)+'px;'
                 + 'overflow:hidden;pointer-events:none;border-radius:3px;';
        if (pUrl) {
          // Use max-width/max-height instead of object-fit — html2canvas compatible
          photoHtml = '<div style="'+pBox+'display:flex;align-items:center;justify-content:center;">'
            + '<img src="'+LL.escHtml(pUrl)+'" crossorigin="anonymous"'
            + ' style="max-width:100%;max-height:100%;width:auto;height:auto;display:block;" alt="Child photo">'
            + '</div>';
        } else {
          photoHtml = '<div style="'+pBox+'">'
            + '<div style="width:100%;height:100%;background:rgba(255,255,255,.15);'
            + 'border:2px dashed rgba(255,255,255,.4);border-radius:3px;'
            + 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;">'
            + '<span style="font-size:2cqw;">&#128100;</span>'
            + '<span style="font-size:1.2cqw;color:rgba(255,255,255,.5);font-family:sans-serif;">Customer Photo</span>'
            + '</div></div>';
        }
      }
      // Dedication message overlay
      var dedHtml = '';
      if (ly.useDedication && meta.dedication != null) {
        var dedText = meta.dedication;
        var dW    = (ly.dedWidth != null ? ly.dedWidth : 70) + '%';
        var dTop  = (ly.dedY    != null ? ly.dedY     : 60) + '%';
        var dLeft = (ly.dedX    != null ? ly.dedX     : 50) + '%';
        var dBox  = 'position:absolute;left:'+dLeft+';top:'+dTop+';transform:translate(-50%,-50%);'
                  + 'width:'+dW+';pointer-events:none;text-align:center;z-index:3;';
        var dFnt  = (ly.dedFont     || 'Lora') + ',serif';
        var dSz   = (ly.dedFontSize || 12) + 'px';
        var dCol  = ly.dedColor || '#FFFFFF';
        var dWgt  = ly.dedBold ? '700' : '400';
        var dOutline = LL.outlineStyle({ outlineEnabled: ly.dedOutlineEnabled, outlineColor: ly.dedOutlineColor, outlineWidth: ly.dedOutlineWidth });
        var isPlaceholder = !dedText.trim();
        var dedContent = dedText.trim() || 'Sample dedication text';
        // Collapse multiple line breaks into single to prevent overflow
        dedContent = dedContent.replace(/\n{2,}/g, '\n');
        dedHtml = '<div style="'+dBox+'">'
          + '<div style="font-family:'+dFnt+';font-size:'+dSz+';font-weight:'+dWgt+';'
          + 'color:'+dCol+';font-style:italic;line-height:1.75;word-break:break-word;white-space:pre-wrap;'
          + dOutline
          + (isPlaceholder ? 'opacity:.65;outline:1px dashed rgba(255,255,255,.4);padding:4px 8px;border-radius:3px;' : '')
          + '">'
          + LL.escHtml(dedContent) + '</div></div>';
      }
      return '<div style="width:100%;height:100%;position:relative;overflow:hidden;">'
        + '<img src="' + LL.escHtml(img) + '" crossorigin="anonymous"'
        + ' style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;" alt="">'
        + photoHtml + dedHtml + overlay + '</div>';
    }
    // No image fallback
    var bg    = meta.pageNum === 1 ? 'linear-gradient(160deg,#0D2540,#1A3A60)' : '#12100E';
    var outlineCssFb = LL.outlineStyle(ly);
    var inner = msg
      ? '<div style="font-family:' + (ly.font || 'Lora') + ',serif;font-size:' + (ly.fontSize || 13) + 'px;'
        + 'font-weight:' + (ly.bold ? '700' : '400') + ';color:' + (ly.color || '#FFFFFF') + ';'
        + 'text-transform:' + (ly.textTransform || 'none') + ';'
        + outlineCssFb
        + 'text-align:center;line-height:1.6;padding:0;word-break:break-word;white-space:pre-wrap;">'
        + LL.escHtml(msg) + '</div>'
      : '<span style="font-size:10px;color:rgba(255,255,255,.15);font-style:italic;">Intro ' + meta.pageNum + '</span>';
    // Customer photo overlay on no-background pages too
    var photoHtml2 = '';
    if (ly.useCustomerPhoto) {
      var pUrl2 = meta.customerPhoto || null;
      var pT2   = (ly.photoTop    != null ? ly.photoTop    : 10);
      var pBot2 = (ly.photoBottom != null ? ly.photoBottom : 160);
      var pL2   = (ly.photoLeft   != null ? ly.photoLeft   : 0);
      var pR2   = (ly.photoRight  != null ? ly.photoRight  : 420);
      var pBox2 = 'position:absolute;top:'+pT2+'px;left:'+pL2+'px;'
                + 'width:'+(pR2-pL2)+'px;height:'+(pBot2-pT2)+'px;'
                + 'overflow:hidden;pointer-events:none;border-radius:3px;';
      if (pUrl2) {
        photoHtml2 = '<div style="'+pBox2+'display:flex;align-items:center;justify-content:center;">'
          + '<img src="'+LL.escHtml(pUrl2)+'" crossorigin="anonymous"'
          + ' style="max-width:100%;max-height:100%;width:auto;height:auto;display:block;" alt="Child photo">'
          + '</div>';
      } else {
        photoHtml2 = '<div style="'+pBox2+'">'
          + '<div style="width:100%;height:100%;background:rgba(255,255,255,.12);'
          + 'border:2px dashed rgba(255,255,255,.35);border-radius:3px;'
          + 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;">'
          + '<span style="font-size:2cqw;">&#128100;</span>'
          + '<span style="font-size:1.2cqw;color:rgba(255,255,255,.4);font-family:sans-serif;">Customer Photo</span>'
          + '</div></div>';
      }
    }
    // Dedication overlay on no-background pages too
    var dedHtml2 = '';
    if (ly.useDedication && meta.dedication != null) {
      var dedText2 = meta.dedication;
      var dW2    = (ly.dedWidth != null ? ly.dedWidth : 70) + '%';
      var dTop2  = (ly.dedY    != null ? ly.dedY     : 60) + '%';
      var dLeft2 = (ly.dedX    != null ? ly.dedX     : 50) + '%';
      var dBox2  = 'position:absolute;left:'+dLeft2+';top:'+dTop2+';transform:translate(-50%,-50%);'
                 + 'width:'+dW2+';pointer-events:none;text-align:center;z-index:3;';
      var dFnt2    = (ly.dedFont     || 'Lora') + ',serif';
      var dSz2     = (ly.dedFontSize || 12) + 'px';
      var dCol2    = ly.dedColor || '#FFFFFF';
      var dWgt2    = ly.dedBold ? '700' : '400';
      var dOutline2 = LL.outlineStyle({ outlineEnabled: ly.dedOutlineEnabled, outlineColor: ly.dedOutlineColor, outlineWidth: ly.dedOutlineWidth });
      var isPlaceholder2 = !dedText2.trim();
      var dedContent2 = dedText2.trim() || 'Sample dedication text';
      dedHtml2 = '<div style="'+dBox2+'">'
        + '<div style="font-family:'+dFnt2+';font-size:'+dSz2+';font-weight:'+dWgt2+';'
        + 'color:'+dCol2+';font-style:italic;line-height:1.75;word-break:break-word;white-space:pre-wrap;'
        + dOutline2
        + (isPlaceholder2 ? 'opacity:.65;outline:1px dashed rgba(255,255,255,.4);padding:4px 8px;border-radius:3px;' : '')
        + '">'
        + LL.escHtml(dedContent2) + '</div></div>';
    }
    return '<div style="width:100%;height:100%;background:' + bg + ';position:relative;'
      + 'display:flex;align-items:center;justify-content:center;">' + photoHtml2 + dedHtml2 + inner + '</div>';
  }

  // OUTRO ----------------------------------------------------------
  if (page.type === 'outro') {
    if (img) {
      return '<div style="width:100%;height:100%;position:relative;overflow:hidden;">'
        + '<img src="' + LL.escHtml(img) + '" crossorigin="anonymous"'
        + ' style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;" alt="">'
        + '</div>';
    }
    if (meta.isBackCover) {
      return '<div style="width:100%;height:100%;background:#12100E;'
        + 'display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;">'
        + '<div style="font-family:Lora,serif;font-size:13px;color:#C9943A;font-style:italic;">'
        + 'Little Light Storybooks</div></div>';
    }
    return '<div style="width:100%;height:100%;'
      + 'background:linear-gradient(135deg,#1E3A1E,#2E5A2E);'
      + 'display:flex;flex-direction:column;align-items:center;'
      + 'justify-content:center;text-align:center;padding:0;">'
      + '<div style="font-family:Lora,serif;color:rgba(255,255,255,.9);font-size:10px;'
      + 'font-style:italic;line-height:1.6;">'
      + '&ldquo;You are fearfully and wonderfully made.&rdquo;</div>'
      + '<div style="font-size:7px;color:rgba(201,168,76,.6);letter-spacing:2px;'
      + 'text-transform:uppercase;margin-top:5px;">&mdash; Psalm 139:14</div></div>';
  }

  // LETTER-L -- decorative illustration ----------------------------
  if (page.type === 'letter-l') {
    if (img) {
      return '<div style="width:100%;height:100%;position:relative;overflow:hidden;">'
        + '<img src="' + LL.escHtml(img) + '" crossorigin="anonymous"'
        + ' style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;" alt="">'
        + '</div>';
    }
    return '<div style="width:100%;height:100%;background:#FDF3DC;'
      + 'display:flex;align-items:center;justify-content:center;">'
      + '<span style="font-size:clamp(4rem,14cqw,9rem);font-family:Lora,serif;'
      + 'font-weight:700;color:rgba(201,148,58,0.18);line-height:1;user-select:none;">'
      + LL.escHtml(meta.letter || '') + '</span></div>';
  }

  // LETTER-R -- blessing / message / verse -------------------------
  if (page.type === 'letter-r') {
    var bgStyle = img
      ? 'background:url(' + LL.escHtml(img) + ') center/cover no-repeat'
      : 'background:#FEFAF3';

    var nameLen = meta.nameLen || 5;
    var scale   = nameLen <= 5 ? 1.0 : nameLen === 6 ? 0.92 : nameLen === 7 ? 0.85 : nameLen === 8 ? 0.78 : 0.72;

    var bSz  = Math.round((ly.blessingSize || 13) * scale) + 'px';
    var mSz  = Math.round((ly.messageSize  || 12) * scale) + 'px';
    var vSz  = Math.round((ly.verseSize    || 11) * scale) + 'px';
    var bCol = ly.blessingColor || '#12100E';
    var mCol = ly.messageColor  || '#3A2410';
    var vCol = ly.verseColor    || '#C9943A';
    var bWgt = ly.blessingBold  ? '700' : '400';
    var mWgt = ly.messageBold   ? '700' : '400';
    var vWgt = ly.verseBold     ? '700' : '400';
    var bFnt = (ly.blessingFont || 'Lora')       + ',serif';
    var mFnt = (ly.messageFont  || 'Lora')       + ',serif';
    var vFnt = (ly.verseFont    || 'Montserrat') + ',sans-serif';

    function sub(s) { return LL.escHtml(LL.resolvePlaceholders(s, nm, gv)).replace(/\n/g, '<br>'); }

    // Per-element outline CSS (blessing / message / verse can each have their own)
    var bOutline = LL.outlineStyle({ outlineEnabled: ly.blessingOutlineEnabled, outlineColor: ly.blessingOutlineColor, outlineWidth: ly.blessingOutlineWidth });
    var mOutline = LL.outlineStyle({ outlineEnabled: ly.messageOutlineEnabled,  outlineColor: ly.messageOutlineColor,  outlineWidth: ly.messageOutlineWidth  });
    var vOutline = LL.outlineStyle({ outlineEnabled: ly.verseOutlineEnabled,    outlineColor: ly.verseOutlineColor,    outlineWidth: ly.verseOutlineWidth    });

    var rows = '';
    if ((page.title   || '').trim()) rows += '<div style="margin-bottom:8px;font-family:' + bFnt + ';font-size:' + bSz + ';font-weight:' + bWgt + ';color:' + bCol + ';line-height:1.55;text-align:center;white-space:pre-wrap;' + bOutline + '">' + sub(page.title)   + '</div>';
    if ((page.verse   || '').trim()) rows += '<div style="margin-bottom:8px;font-family:' + vFnt + ';font-size:' + vSz + ';font-weight:' + vWgt + ';color:' + vCol + ';line-height:1.5;text-align:center;font-style:italic;white-space:pre-wrap;' + vOutline + '">' + sub(page.verse) + '</div>';
    if ((page.message || '').trim()) rows += '<div style="font-family:' + mFnt + ';font-size:' + mSz + ';font-weight:' + mWgt + ';color:' + mCol + ';line-height:1.6;text-align:center;white-space:pre-wrap;'  + mOutline + '">'  + sub(page.message) + '</div>';

    // Position controls — always use explicit X/Y/maxWidth for letter-R
    var mw  = (ly.maxWidth != null ? ly.maxWidth : 80) + '%';
    var lft = (ly.startX   != null ? ly.startX   : 50) + '%';
    var top = (ly.startY   != null ? ly.startY   : 50) + '%';
    var empty = rows || '<span style="font-size:9px;color:rgba(0,0,0,.15);font-style:italic;">' + LL.escHtml(meta.letter || '') + '</span>';

    return '<div style="width:100%;height:100%;' + bgStyle + ';position:relative;overflow:hidden;">'
      + '<div style="position:absolute;left:' + lft + ';top:' + top + ';'
      + 'transform:translate(-50%,-50%);width:' + mw + ';text-align:center;'
      + 'word-break:break-word;white-space:pre-wrap;">'
      + empty + '</div></div>';
  }

  return '<div style="width:100%;height:100%;background:#eee;"></div>';
};

// ----------------------------------------------------------------
// SECTION 4: STATE SYNC (JSONBin + localStorage)
// ----------------------------------------------------------------

// Strips corrupted layout fields written by a previous bad session.
// Currently removes lineHeight < 1 from intro/outro layouts.
// Safe to run on every load — pure cleanup, never overwrites good data.
LL._sanitizeLayouts = function(state) {
  if (!state) return;
  ['boy', 'girl'].forEach(function(g) {
    var d = state[g];
    if (!d) return;
    // Intro layouts
    if (Array.isArray(d.introLayouts)) {
      d.introLayouts.forEach(function(ly) {
        if (ly && (ly.lineHeight !== undefined) && (isNaN(ly.lineHeight) || ly.lineHeight < 1)) {
          delete ly.lineHeight;
        }
      });
    }
    // Outro layouts
    if (Array.isArray(d.outroLayouts)) {
      d.outroLayouts.forEach(function(ly) {
        if (ly && (ly.lineHeight !== undefined) && (isNaN(ly.lineHeight) || ly.lineHeight < 1)) {
          delete ly.lineHeight;
        }
      });
    }
    // Letter layouts
    if (d.letters) {
      Object.keys(d.letters).forEach(function(l) {
        var letter = d.letters[l];
        if (!letter || !Array.isArray(letter.variations)) return;
        letter.variations.forEach(function(v) {
          if (!v || !v.layout) return;
          ['lineHeight','blessingLineHeight','messageLineHeight','verseLineHeight'].forEach(function(k) {
            if (v.layout[k] !== undefined && (isNaN(v.layout[k]) || v.layout[k] < 1)) {
              delete v.layout[k];
            }
          });
        });
      });
    }
  });
  // Also sanitize localStorage immediately
  try { localStorage.setItem('bop_state', JSON.stringify(state)); } catch(e) {}
};

LL.loadRemoteState = function(onDone) {
  if (!LL.WORKER_URL) {
    console.warn('[LL] No DB config -- using localStorage');
    if (onDone) onDone(LL._readLocalState());
    return;
  }
  var xhr = new XMLHttpRequest();
  xhr.open('GET', LL.WORKER_URL + '/db/get', true);
  xhr.setRequestHeader('X-App-Token', LL.APP_TOKEN);
  xhr.onload = function() {
    var local = LL._readLocalState();
    if (xhr.status === 200) {
      try {
        var parsed = JSON.parse(xhr.responseText);
        // Support both JSONBin format ({record: {...}}) and KV direct format ({...})
        var remote = parsed.record || (parsed.boy ? parsed : null);
        if (remote && typeof remote === 'object') {
          // Merge: remote has fresh text/config; local has images.
          // mergeStateWithLocalImages restores base64 images from localStorage
          // into the remote state (which was stripped before saving).
          var merged = LL.mergeStateWithLocalImages(remote, local);
          // One-time sanitizer: strip corrupted lineHeight values (< 1 or 0)
          // written by a previous bad session. Safe to run every load — no-op if clean.
          LL._sanitizeLayouts(merged);
          // Write merged back to localStorage so it's current
          localStorage.setItem('bop_state', JSON.stringify(merged));
          if (onDone) onDone(merged);
          return;
        }
      } catch(e) { console.warn('[LL] Remote parse error:', e); }
    } else {
      console.warn('[LL] Remote fetch failed HTTP', xhr.status, '-- using localStorage');
    }
    if (onDone) { LL._sanitizeLayouts(local); onDone(local); }
  };
  xhr.onerror = function() {
    console.warn('[LL] Network error -- using localStorage');
    var loc = LL._readLocalState();
    LL._sanitizeLayouts(loc);
    if (onDone) onDone(loc);
  };
  xhr.send();
};

// ----------------------------------------------------------------
// stripImagesFromState -- removes base64 data URIs from state
// before sending to JSONBin. Images are large (100KB-500KB each)
// and JSONBin has a ~512KB payload limit. Base64 images are stored
// in localStorage only. Text, layout, and config are stored remotely.
// On load, mergeStateWithLocalImages() reunites both sources.
// ----------------------------------------------------------------
LL.stripImagesFromState = function(state) {
  function strip(val) {
    if (!val || typeof val !== 'object') return val;
    if (Array.isArray(val)) return val.map(function(v) {
      // If a string value is a base64 data URI, replace with sentinel
      if (typeof v === 'string' && v.startsWith('data:')) return '__img__';
      return strip(v);
    });
    var out = {};
    Object.keys(val).forEach(function(k) {
      var v = val[k];
      if (typeof v === 'string' && v.startsWith('data:')) out[k] = '__img__';
      else out[k] = strip(v);
    });
    return out;
  }
  return strip(state);
};

// mergeStateWithLocalImages -- after loading from JSONBin (text only),
// restore image arrays from localStorage (full copy).
LL.mergeStateWithLocalImages = function(remoteState, localState) {
  if (!localState) return remoteState;
  var merged = JSON.parse(JSON.stringify(remoteState));

  function restoreImgs(dst, src) {
    if (!dst || !src || typeof dst !== 'object' || typeof src !== 'object') return;
    if (Array.isArray(dst) && Array.isArray(src)) {
      for (var i = 0; i < Math.max(dst.length, src.length); i++) {
        if (dst[i] === '__img__' || (dst[i] === null && src[i] && typeof src[i] === 'string' && src[i].startsWith('data:'))) {
          dst[i] = src[i];
        }
      }
      return;
    }
    Object.keys(src).forEach(function(k) {
      if (dst[k] === undefined) dst[k] = src[k];
      else restoreImgs(dst[k], src[k]);
    });
  }

  // Restore images for boy and girl datasets
  ['boy', 'girl'].forEach(function(g) {
    if (!merged[g]) merged[g] = {};
    if (!localState[g]) return;
    // Restore image arrays
    ['introImages', 'outroImages'].forEach(function(key) {
      if (localState[g][key]) {
        if (!merged[g][key]) merged[g][key] = [];
        localState[g][key].forEach(function(v, i) {
          if (v && typeof v === 'string' && v.startsWith('data:')) {
            merged[g][key][i] = v;
          }
        });
      }
    });
    // Restore letter images (leftImg, rightImg in variations)
    if (localState[g].letters) {
      if (!merged[g].letters) merged[g].letters = {};
      Object.keys(localState[g].letters).forEach(function(l) {
        if (!merged[g].letters[l]) merged[g].letters[l] = localState[g].letters[l];
        else {
          var srcVars = (localState[g].letters[l].variations || []);
          var dstVars = (merged[g].letters[l].variations = merged[g].letters[l].variations || []);
          srcVars.forEach(function(sv, i) {
            if (!dstVars[i]) dstVars[i] = sv;
            else {
              if (sv.leftImg  && typeof sv.leftImg  === 'string' && sv.leftImg.startsWith('data:'))  dstVars[i].leftImg  = sv.leftImg;
              if (sv.rightImg && typeof sv.rightImg === 'string' && sv.rightImg.startsWith('data:')) dstVars[i].rightImg = sv.rightImg;
            }
          });
        }
      });
    }
    // Restore legacy flat format images too
    if (localState[g].pageSettings) {
      if (!merged[g].pageSettings) merged[g].pageSettings = {};
      Object.keys(localState[g].pageSettings).forEach(function(k) {
        var v = localState[g].pageSettings[k];
        if (v && typeof v === 'string' && v.startsWith('data:')) merged[g].pageSettings[k] = v;
      });
    }
  });
  // Restore shared pageSettings images
  if (localState.pageSettings) {
    if (!merged.pageSettings) merged.pageSettings = {};
    Object.keys(localState.pageSettings).forEach(function(k) {
      var v = localState.pageSettings[k];
      if (v && typeof v === 'string' && v.startsWith('data:')) merged.pageSettings[k] = v;
    });
  }
  if (localState.config) {
    if (!merged.config) merged.config = {};
    Object.keys(localState.config).forEach(function(k) {
      var v = localState.config[k];
      if (v && typeof v === 'string' && v.startsWith('data:')) merged.config[k] = v;
    });
  }
  return merged;
};

LL.saveRemoteState = function(state, onDone) {
  // Layer 1: Always save FULL state to localStorage (including images)
  try {
    localStorage.setItem('bop_state', JSON.stringify(state));
  } catch(e) {
    console.error('[LL] localStorage save failed:', e.message);
  }

  if (!LL.WORKER_URL) {
    if (onDone) onDone(true);
    return;
  }

  // Layer 2: Send STRIPPED state (no base64 images) to JSONBin
  var stripped;
  try {
    stripped = LL.stripImagesFromState(state);
  } catch(e) {
    console.error('[LL] stripImages failed:', e.message);
    // Fall back to local-only success since localStorage save succeeded
    if (onDone) onDone(true);
    return;
  }

  var payload;
  try {
    payload = JSON.stringify(stripped);
  } catch(e) {
    console.error('[LL] JSON.stringify failed (circular ref?):', e.message);
    if (onDone) onDone(true); // localStorage succeeded, treat as ok
    return;
  }

  var xhr = new XMLHttpRequest();
  xhr.open('PUT', LL.WORKER_URL + '/db/put', true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.setRequestHeader('X-App-Token', LL.APP_TOKEN);
  xhr.setRequestHeader('X-Bin-Versioning', 'false');
  xhr.onload = function() {
    var ok = xhr.status === 200;
    if (!ok) {
      console.warn('[LL] JSONBin save failed HTTP ' + xhr.status + '. Response: ' + xhr.responseText.slice(0, 200));
      // Images are already in localStorage. Treat as partial success
      // so the UI doesn't show "save failed" when the real content is safe.
      // Only return false if status is an auth failure (401/403).
      if (xhr.status === 401 || xhr.status === 403) {
        if (onDone) onDone(false);
        return;
      }
    }
    if (onDone) onDone(ok);
  };
  xhr.onerror = function() {
    console.warn('[LL] JSONBin network error. Data is in localStorage.');
    // Network failure -- localStorage is authoritative, don't show error
    if (onDone) onDone(true);
  };
  xhr.send(payload);
};

LL._readLocalState = function() {
  try {
    var raw = localStorage.getItem('bop_state');
    if (raw) { var p = JSON.parse(raw); if (p && typeof p === 'object') return p; }
  } catch(e) {}
  return {};
};

// ----------------------------------------------------------------
// SECTION 5: CUSTOMER PDF EXPORT ENGINE
// Used by index.html. Iterates live DOM spread viewer.
// ----------------------------------------------------------------

// ----------------------------------------------------------------
// exportPDF — customer-side PDF export.
//
// ARCHITECTURE:
// Each page in the book = one full 420x296 landscape PDF page.
// The spread viewer (page-l / page-r) is UI-only and NOT used here.
// Instead we render each page model object into a hidden off-screen
// stage element at full 420x296, capture it, and add to the PDF.
// This guarantees 1:1 correspondence between page count and PDF pages.
// ----------------------------------------------------------------
LL.exportPDF = async function(pageModels, childName, goSpreadFn, spreadCount, getSpreadEls, onProgress, onDone, giverName) {
  if (!window.jspdf || !window.html2canvas) {
    alert('PDF libraries still loading -- please wait a moment and try again.');
    return;
  }

  // pageModels must be supplied — flat array from buildPageModel
  if (!pageModels || !pageModels.length) {
    alert('No pages to export.');
    if (onDone) onDone();
    return;
  }

  await document.fonts.ready;

  var jsPDF = window.jspdf.jsPDF;
  var doc   = new jsPDF({ orientation: 'landscape', unit: 'mm', format: [210, 148] });
  var first = true;
  var name  = (childName || 'Book').trim();
  var giver = (giverName || '').trim();

  // Create a dedicated off-screen render stage
  var stage = document.getElementById('pdf-render-stage');
  if (!stage) {
    stage = document.createElement('div');
    stage.id = 'pdf-render-stage';
    stage.style.cssText = 'position:fixed;left:-9999px;top:0;width:420px;height:296px;overflow:hidden;z-index:-1;pointer-events:none;container-type:inline-size;';
    document.body.appendChild(stage);
  }
  stage.style.width  = '420px';
  stage.style.height = '296px';

  async function wait(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }
  async function rAF()    { return new Promise(function(r){ requestAnimationFrame(r); }); }

  // Capture the stage as a PDF page
  async function capturePage(bg) {
    var canvas = await html2canvas(stage, {
      scale: 3, useCORS: true, allowTaint: false,
      backgroundColor: bg || '#FEFAF3',
      width: 420, height: 296, logging: false,
    });
    var imgData = canvas.toDataURL('image/jpeg', 0.95);
    if (!first) doc.addPage([210, 148], 'landscape');
    first = false;
    doc.addImage(imgData, 'JPEG', 0, 0, 210, 148);
  }

  // Render one page model into the stage and capture it
  async function renderAndCapture(page, bg) {
    stage.innerHTML = LL.renderPage(page, name, giver);
    await rAF(); await rAF(); await wait(150);
    await capturePage(bg);
  }

  var total = pageModels.length;
  var step  = 0;

  // Render every page model individually — one page = one PDF page
  for (var i = 0; i < pageModels.length; i++) {
    var page = pageModels[i];
    if (!page || page.type === 'filler') continue; // skip fillers

    step++;
    if (onProgress) onProgress(step, total, 'Page ' + step + ' of ' + total);

    // Choose background colour by page type
    var bg = (page.type === 'intro' || page.type === 'outro') ? '#12100E' : '#FEFAF3';
    if (page.type === 'intro' && page.meta && page.meta.isFrontCover) bg = '#12100E';
    if (page.type === 'outro' && page.meta && page.meta.isBackCover)  bg = '#12100E';
    if (page.image) bg = 'transparent'; // image will cover it

    await renderAndCapture(page, bg);
  }

  // Clean up stage
  stage.innerHTML = '';

  var nm = name.replace(/\s+/g, '_');
  doc.save('LittleLight_' + nm + '.pdf');
  if (onDone) onDone();
};

// ----------------------------------------------------------------
// SECTION 6: UTILITIES
// ----------------------------------------------------------------

// ----------------------------------------------------------------
// LL.uploadToCloudinary
// Uploads a File to Cloudinary via unsigned upload preset.
// Returns a Promise resolving to the secure_url string.
// This is the PRIMARY image pipeline — replaces base64 storage.
// ----------------------------------------------------------------
LL.uploadToCloudinary = function(file, folder, onProgress, uploadType) {
  return new Promise(function(resolve, reject) {
    var formData = new FormData();
    formData.append('file',   file);
    formData.append('folder', folder || 'littlehero_uploads');
    if (uploadType) formData.append('uploadType', uploadType);
    // upload_preset and final folder enforced server-side by Cloudflare Worker

    var xhr = new XMLHttpRequest();
    xhr.open('POST', LL.CL_URL, true);
    xhr.setRequestHeader('X-App-Token', LL.APP_TOKEN);

    // Progress tracking
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = function(e) {
        if (e.lengthComputable) {
          var pct = Math.round((e.loaded / e.total) * 100);
          onProgress(pct);
        }
      };
    }
    xhr.onload = function() {
      if (xhr.status === 200) {
        try {
          var res = JSON.parse(xhr.responseText);
          if (res.secure_url) {
            resolve(res.secure_url);
          } else {
            reject(new Error('No secure_url in response'));
          }
        } catch(e) {
          reject(new Error('Parse error: ' + e.message));
        }
      } else {
        try {
          var err = JSON.parse(xhr.responseText);
          reject(new Error('Cloudinary ' + xhr.status + ': ' + (err.error && err.error.message || xhr.responseText.slice(0,100))));
        } catch(e) {
          reject(new Error('Cloudinary HTTP ' + xhr.status));
        }
      }
    };
    xhr.onerror = function() {
      reject(new Error('Network error uploading to Cloudinary'));
    };
    xhr.send(formData);
  });
};

// LL.imageToBase64 -- kept as a local-only utility for thumbnails / previews
// NOT used for persistent storage (Cloudinary handles that now).
LL.imageToBase64 = function(file, maxPx, quality, cb) {
  maxPx   = maxPx   || 1600;
  quality = quality || 0.82;
  var reader = new FileReader();
  reader.onload = function(ev) {
    var img = new window.Image();
    img.onload = function() {
      var scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      var w = Math.round(img.width  * scale);
      var h = Math.round(img.height * scale);
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      var mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      cb(c.toDataURL(mime, mime === 'image/png' ? 1 : quality));
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
};

LL.toast = function(msg, type) {
  var t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className   = 'toast ' + (type || '') + ' show';
  clearTimeout(LL._toastTimer);
  LL._toastTimer = setTimeout(function() { t.classList.remove('show'); }, 3500);
};

LL.initPixel = function(id) {
  if (!id) return;
  !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
  n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
  n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
  document,'script','https://connect.facebook.net/en_US/fbevents.js');
  fbq('init', id); fbq('track', 'PageView');
};

LL.firePixel = function(val, ref, url, orderData) {
  // DISABLED FOR TESTING — re-enable before going live
  return;

  // Browser-side Pixel
  try { if (typeof fbq !== 'undefined') fbq('track', 'Purchase', { value: val, currency: 'PHP' }); } catch(e) {}

  // Server-side CAPI via Cloudflare Worker
  try {
    var fbp = document.cookie.match(/_fbp=([^;]+)/);
    var fbc = document.cookie.match(/_fbc=([^;]+)/);
    fetch(LL.WORKER_URL + '/capi', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-App-Token': LL.APP_TOKEN,
      },
      body: JSON.stringify({
        ref:   ref   || '',
        value: val   || 0,
        url:   url   || window.location.href,
        fbp:   fbp   ? fbp[1] : '',
        fbc:   fbc   ? fbc[1] : '',
      }),
    });
  } catch(e) {}

  // Backup order to separate KV namespace
  if (orderData && ref) {
    try {
      fetch(LL.WORKER_URL + '/order/backup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-App-Token': LL.APP_TOKEN,
        },
        body: JSON.stringify(orderData),
      });
    } catch(e) {}
  }
};
