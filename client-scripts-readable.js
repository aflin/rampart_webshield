/*
    Readable versions of the client-side scripts injected by rampart-webshield.
    These are minified and obfuscated before injection.
    Edit here, then update the minified versions in rampart-webshield.js.
*/

/* ============================================================
   Image unscramble script (clientUnscrambleScript)

   Runs on page load. For each <img data-ws-scrambled>, loads the
   scrambled image, creates a canvas, unshuffles the tiles, and
   displays the canvas in front of the scrambled img.

   Also monitors for DevTools (CDP Proxy trap) every 250ms.
   If detected, removes canvases and shows the scrambled images.
   ============================================================ */

(function() {

    // xorshift64 PRNG (matches C module's xorRand64)
    function xorRng(seed) {
        var hi = (seed / 0x100000000) >>> 0;
        var lo = seed >>> 0;
        if (!hi && !lo) { hi = 0xFEE1BADC; lo = 0xEEDBA110; }
        return {
            next: function() {
                var s;
                s = (hi << 13) | (lo >>> 19); lo ^= lo << 13; hi ^= s;
                s = hi >>> 7; lo ^= (lo >>> 7) | (hi << 25); hi ^= s;
                s = (hi << 17) | (lo >>> 15); lo ^= lo << 17; hi ^= s;
                hi = hi >>> 0; lo = lo >>> 0;
                return { hi: hi, lo: lo };
            },
            mod: function(m) {
                var v = this.next();
                return ((v.hi % m) * (4294967296 % m) % m + v.lo % m) % m;
            }
        };
    }

    // Reverse the Fisher-Yates tile shuffle
    function unshuffle(img, cvs, w, h, ts, seed) {
        var cols = Math.ceil(w / ts);
        var rows = Math.ceil(h / ts);
        var n = cols * rows;
        var perm = [], i;

        for (i = 0; i < n; i++) perm[i] = i;

        var rng = xorRng(seed);
        for (i = n - 1; i > 0; i--) {
            var j = rng.mod(i + 1);
            var t = perm[i]; perm[i] = perm[j]; perm[j] = t;
        }

        var ctx = cvs.getContext("2d");
        for (i = 0; i < n; i++) {
            var di = perm[i];
            var sx = (i % cols) * ts,  sy = Math.floor(i / cols) * ts;
            var dx = (di % cols) * ts, dy = Math.floor(di / cols) * ts;
            var sw = Math.min(ts, w - sx), sh = Math.min(ts, h - sy);
            var dw = Math.min(ts, w - dx), dh = Math.min(ts, h - dy);
            var cw = Math.min(sw, dw),     ch = Math.min(sh, dh);
            ctx.drawImage(img, sx, sy, cw, ch, dx, dy, cw, ch);
        }
    }

    // Process all scrambled images
    var imgs = document.querySelectorAll("img[data-ws-scrambled]");
    for (var k = 0; k < imgs.length; k++) {
        (function(el) {
            var ts    = parseInt(el.getAttribute("data-ws-tile")) || 32;
            var seed  = parseInt(el.getAttribute("data-ws-seed")) || 0;
            var origW = parseInt(el.getAttribute("data-ws-origw")) || 0;
            var origH = parseInt(el.getAttribute("data-ws-origh")) || 0;

            var tmp = new Image();
            if (/^https?:/.test(el.src)) tmp.crossOrigin = "anonymous";
            function doUnshuffle(el, ts, seed, origW, origH) {
                var imgW = el.naturalWidth || el.width;
                var imgH = el.naturalHeight || el.height;
                if (!imgW || !imgH) return;

                var cvs = document.createElement("canvas");
                cvs.width = origW || imgW;
                cvs.height = origH || imgH;

                // Wrap: canvas behind, scrambled img in front at opacity 0
                var wrap = document.createElement("div");
                wrap.style.position = "relative";
                wrap.style.display = "inline-block";
                wrap.style.cssText += el.style.cssText;
                wrap.className = el.className;

                cvs.setAttribute("data-ws-canvas", "1");
                cvs.style.width = "100%";
                cvs.style.height = "auto";
                cvs.style.display = "block";

                el.parentNode.insertBefore(wrap, el);
                wrap.appendChild(cvs);
                wrap.appendChild(el);
                el.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;opacity:0";

                // Firefox won't paint canvas from callbacks.
                // Poll until the canvas actually has content.
                var iv = setInterval(function() {
                    unshuffle(el, cvs, imgW, imgH, ts, seed);
                    try {
                        var px = cvs.getContext("2d").getImageData(0, 0, 1, 1).data;
                        if (px[3] > 0) clearInterval(iv);
                    } catch(e) { clearInterval(iv); }
                }, 100);
            }

            if (el.complete && el.naturalWidth) {
                doUnshuffle(el, ts, seed, origW, origH);
            } else {
                el.addEventListener("load", function() {
                    doUnshuffle(el, ts, seed, origW, origH);
                });
            }
        })(imgs[k]);
    }

    // Clear all unscrambled canvases and show scrambled images
    function clearCanvases() {
        var canvases = document.querySelectorAll("canvas[data-ws-canvas]");
        for (var i = 0; i < canvases.length; i++) {
            canvases[i].getContext("2d").clearRect(0, 0, canvases[i].width, canvases[i].height);
            canvases[i].remove();
        }
        var scrambled = document.querySelectorAll("img[data-ws-scrambled]");
        for (var i = 0; i < scrambled.length; i++) {
            scrambled[i].style.cssText = "";
            scrambled[i].style.width = "100%";
        }
    }

    // Monitor for DevTools every 250ms using two methods:
    // 1. CDP Proxy trap (Chrome: catches automation + DevTools)
    // 2. debugger timing (Firefox/Safari: pauses when DevTools open,
    //    clears canvases immediately when user resumes)
    setInterval(function() {
        // Method 1: CDP Proxy trap
        var detected = false;
        try {
            var trap = new Proxy({}, { ownKeys: function() { detected = true; return []; } });
            console.groupEnd(Object.create(trap));
        } catch(e) {}
        if (detected) { clearCanvases(); return; }

        // Method 2: debugger timing
        var t1 = performance.now();
        (function() { debugger; })();
        if (performance.now() - t1 > 10) clearCanvases();
    }, 250);

})();


/* ============================================================
   Guard script (built by applyGuard)

   Runs on page load. Checks for CDP (Chrome DevTools Protocol)
   using the Proxy trap. If CDP is detected, shows the page
   without loading the font or unscrambling images. If not
   detected, waits {delay}ms then loads the font and runs the
   image unscramble script.

   The font-face CSS and delay are injected dynamically.
   When images are present, the unscramble script above is
   embedded inside the loadFonts function.
   ============================================================ */

(function() {

    // Load the scrambled font and (optionally) unscramble images
    function loadFonts() {
        var s = document.createElement("style");
        s.textContent = "{{FONT_FACE_CSS}}";   // injected by applyGuard
        document.head.appendChild(s);
        document.fonts.ready.then(function() {
            document.body.style.opacity = "1";
        });

        // {{IMAGE_UNSCRAMBLE_SCRIPT}}  -- inserted here when images are present
    }

    // Fallback: show page without font (scrambled text visible)
    function show() {
        document.body.style.opacity = "1";
    }

    // CDP Proxy trap
    var cdpDetected = false;
    try {
        var trap = new Proxy({}, { ownKeys: function() { cdpDetected = true; return []; } });
        console.groupEnd(Object.create(trap));
    } catch(e) {}

    if (cdpDetected) {
        // Bot detected — show scrambled page
        show();
    } else {
        // Human — load font after delay
        setTimeout(function() {
            loadFonts();
        }, 500);  // {{DELAY}} injected by applyGuard
    }

})();
