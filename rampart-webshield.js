/*
    rampart-webshield.js - Web page protection module

    Usage:
        var ws = require("rampart-webshield");

        // Simple mode (1-to-1 substitution):
        var result = ws.fontshuffle(html, seed);

        // Multi mode (many-to-1, defeats frequency analysis):
        var result = ws.fontshuffle(html, seed, {mode: "multi"});

        // Reuse existing mappings (skip font generation):
        var result = ws.fontshuffle(html, seed, {mappings: savedMappings});

    Parameters:
        html    - String: HTML text, or a filename to read
        seed    - Number: PRNG seed
        options - Object (optional):
            mode:     "simple" (default) or "multi"
            mappings: Object from a previous run's result.mappings to reuse

    Returns:
        {
            text:     String   (obfuscated HTML with updated font URLs),
            fonts:    Array    [ { name: "file.ws.ttf", data: Buffer }, ... ],
            mappings: Object   { "fonturl": { mode: "simple"|"multi", map: {...} } }
        }

    In simple mode, map is { "origCp": newCp, ... }
    In multi mode,  map is { "origCp": [newCp1, newCp2, ...], ... }

    Elements with the data-no-scramble attribute are not scrambled.
*/

var fontshuffle_c = require("rampart-fontshuffle");
var htmlmod = require("rampart-html");
var curl = require("rampart-curl");

/* ============================================================
   Simple seeded PRNG for JS
   ============================================================ */

function JsRng(seed) {
    this.hi = (seed / 0x100000000) >>> 0;
    this.lo = seed >>> 0;
    if (this.hi === 0 && this.lo === 0) {
        this.hi = 0xFEE1BADC;
        this.lo = 0xEEDBA110;
    }
}

JsRng.prototype.next = function() {
    var hi = this.hi, lo = this.lo;
    var shi = (hi << 13) | (lo >>> 19);
    var slo = lo << 13;
    hi ^= shi; lo ^= slo;
    shi = hi >>> 7;
    slo = (lo >>> 7) | (hi << 25);
    hi ^= shi; lo ^= slo;
    shi = (hi << 17) | (lo >>> 15);
    slo = lo << 17;
    hi ^= shi; lo ^= slo;
    this.hi = hi >>> 0;
    this.lo = lo >>> 0;
    return this.lo >>> 0;
};

JsRng.prototype.randInt = function(max) {
    return this.next() % max;
};

/* ============================================================
   Extract @font-face font URLs from CSS text.
   ============================================================ */

function extractFontUrls(cssText) {
    var fonts = [];
    var re = /@font-face\s*\{[^}]*\}/g;
    var match;
    while ((match = re.exec(cssText)) !== null) {
        var block = match[0];
        var urlRe = /url\(\s*['"]?([^'")]+?)['"]?\s*\)/g;
        var urlMatch;
        while ((urlMatch = urlRe.exec(block)) !== null) {
            var fontUrl = urlMatch[1];
            if (/^data:/.test(fontUrl)) continue;
            fonts.push({
                url: fontUrl,
                isRemote: /^https?:\/\//.test(fontUrl),
                cssBlock: block
            });
        }
    }
    return fonts;
}

/* ============================================================
   Load a font: local file or remote URL.
   ============================================================ */

function loadFont(fontUrl, isRemote, baseDir) {
    if (isRemote) {
        try {
            var res = curl.fetch(fontUrl);
            if (res.status === 200 && res.body && res.body.length > 0)
                return res.body;
        } catch(e) { /* fall through */ }
        return null;
    }
    var path;
    if (fontUrl.charAt(0) === '/')
        path = fontUrl;
    else
        path = baseDir + '/' + fontUrl;
    return rampart.utils.readFile(path) || null;
}

/* ============================================================
   Generate obfuscated filename from original URL.
   ============================================================ */

function obfuscatedName(url, seed) {
    var basename = url.replace(/^.*\//, '').replace(/[?#].*$/, '');
    var ext = basename.replace(/^.*(\.[^.]+)$/, '$1');
    var name = basename.replace(/\.[^.]+$/, '');
    return name + '.ws.' + seed + ext;
}

/* ============================================================
   HTML walker: tracks tag state, script/style depth, and
   data-no-scramble / data-scramble zones.
   Supports nesting: data-scramble inside data-no-scramble
   re-enables scrambling for that subtree.
   ============================================================ */

function HtmlWalker(htmlStr) {
    this.str = htmlStr;
    this.len = htmlStr.length;
    this.i = 0;
    this.inTag = false;
    this.tagBuf = '';
    this.inScript = 0;
    this.inStyle = 0;
    this.inTitle = 0;
    this.zoneStack = [];  /* stack of {tagName, depth, protect} */
}

HtmlWalker.prototype.analyzeTag = function() {
    var tag = this.tagBuf;
    var lower = tag.toLowerCase();
    var nameMatch = lower.match(/^<\/?([a-z][a-z0-9]*)/);
    var tagName = nameMatch ? nameMatch[1] : '';
    var isClosing = (lower.charAt(1) === '/');
    var isSelfClosing = (tag.charAt(tag.length - 1) === '/' ||
        /^(br|hr|img|input|link|meta|col|area|base|param|track|wbr|keygen)$/.test(tagName));

    if (!isClosing && tagName === 'script') this.inScript++;
    else if (isClosing && tagName === 'script') this.inScript = Math.max(0, this.inScript - 1);
    else if (!isClosing && tagName === 'style') this.inStyle++;
    else if (isClosing && tagName === 'style') this.inStyle = Math.max(0, this.inStyle - 1);
    else if (!isClosing && tagName === 'title') this.inTitle++;
    else if (isClosing && tagName === 'title') this.inTitle = Math.max(0, this.inTitle - 1);

    /* Zone stack: track data-no-scramble and data-scramble nesting */
    var top = this.zoneStack.length > 0 ? this.zoneStack[this.zoneStack.length - 1] : null;

    if (top) {
        if (isClosing && tagName === top.tagName) {
            top.depth--;
            if (top.depth === 0) this.zoneStack.pop();
        } else if (!isClosing && !isSelfClosing && tagName === top.tagName) {
            top.depth++;
        }
    }

    if (!isClosing && !isSelfClosing) {
        if (/data-no-scramble/.test(tag)) {
            this.zoneStack.push({ tagName: tagName, depth: 1, protect: true });
        } else if (/data-scramble/.test(tag) && !(/data-no-scramble/.test(tag))) {
            this.zoneStack.push({ tagName: tagName, depth: 1, protect: false });
        }
    }
};

HtmlWalker.prototype.isProtected = function() {
    if (this.inTag || this.inScript > 0 || this.inStyle > 0 || this.inTitle > 0)
        return true;
    /* Check zone stack: topmost zone determines scramble state */
    for (var i = this.zoneStack.length - 1; i >= 0; i--) {
        return this.zoneStack[i].protect;
    }
    return false;  /* no zones — default is to scramble */
};

/* ============================================================
   Scan HTML text content for used codepoints.
   Skips tags, scripts, styles, entities, data-no-scramble zones.
   ============================================================ */

function scanUsedCodepoints(htmlStr) {
    var used = {};
    var w = new HtmlWalker(htmlStr);

    while (w.i < w.len) {
        var ch = w.str.charAt(w.i);

        if (ch === '<') {
            w.inTag = true;
            w.tagBuf = ch;
            w.i++; continue;
        }
        if (w.inTag) {
            w.tagBuf += ch;
            if (ch === '>') {
                w.analyzeTag();
                w.inTag = false;
                w.tagBuf = '';
            }
            w.i++; continue;
        }
        if (w.isProtected()) { w.i++; continue; }

        if (ch === '&') {
            var semi = w.str.indexOf(';', w.i + 1);
            if (semi > 0 && semi - w.i <= 10) { w.i = semi + 1; continue; }
        }

        var cp = w.str.charCodeAt(w.i);
        if (cp >= 0xD800 && cp <= 0xDBFF && w.i + 1 < w.len) {
            var lo = w.str.charCodeAt(w.i + 1);
            if (lo >= 0xDC00 && lo <= 0xDFFF) {
                cp = ((cp - 0xD800) << 10) + (lo - 0xDC00) + 0x10000;
                w.i += 2;
                used[cp] = true;
                continue;
            }
        }
        used[cp] = true;
        w.i++;
    }
    return used;
}

/* ============================================================
   Remap text content in HTML.
   Respects data-no-scramble attribute.
   ============================================================ */

function remapHtmlText(htmlStr, mapping, isMulti) {
    var out = [];
    var w = new HtmlWalker(htmlStr);

    while (w.i < w.len) {
        var ch = w.str.charAt(w.i);

        if (ch === '<') {
            w.inTag = true;
            w.tagBuf = ch;
            out.push(ch);
            w.i++; continue;
        }
        if (w.inTag) {
            w.tagBuf += ch;
            if (ch === '>') {
                w.analyzeTag();
                w.inTag = false;
                w.tagBuf = '';
            }
            out.push(ch);
            w.i++; continue;
        }
        if (w.isProtected()) {
            out.push(ch);
            w.i++; continue;
        }

        /* Replace zero-width characters with HTML entities so
           the browser handles them natively, not via the font */
        var cp0 = w.str.charCodeAt(w.i);
        if (cp0 >= 0x200B && cp0 <= 0x200F) {
            out.push('&#x' + cp0.toString(16) + ';');
            w.i++; continue;
        }

        if (ch === '&') {
            var semi = w.str.indexOf(';', w.i + 1);
            if (semi > 0 && semi - w.i <= 10) {
                out.push(w.str.substring(w.i, semi + 1));
                w.i = semi + 1; continue;
            }
        }

        var cp = w.str.charCodeAt(w.i);

        if (cp >= 0xD800 && cp <= 0xDBFF && w.i + 1 < w.len) {
            var lo = w.str.charCodeAt(w.i + 1);
            if (lo >= 0xDC00 && lo <= 0xDFFF) {
                cp = ((cp - 0xD800) << 10) + (lo - 0xDC00) + 0x10000;
                var newCp = pickMapping(mapping, cp, isMulti);
                pushCodepoint(out, newCp !== null ? newCp : cp);
                w.i += 2; continue;
            }
        }

        var newCp = pickMapping(mapping, cp, isMulti);
        pushCodepoint(out, newCp !== null ? newCp : cp);
        w.i++;
    }

    return out.join('');
}

function pickMapping(mapping, cp, isMulti) {
    var cpStr = String(cp);
    var val = mapping[cpStr];
    if (val === undefined) return null;
    if (isMulti) {
        return val[Math.floor(Math.random() * val.length)];
    }
    return val;
}

function pushCodepoint(out, cp) {
    if (cp > 0xFFFF) {
        var hi = Math.floor((cp - 0x10000) / 0x400) + 0xD800;
        var lo = ((cp - 0x10000) % 0x400) + 0xDC00;
        out.push(String.fromCharCode(hi, lo));
    } else {
        out.push(String.fromCharCode(cp));
    }
}

/* ============================================================
   Replace font URLs in text.
   ============================================================ */

function updateFontUrls(text, urlMap) {
    for (var origUrl in urlMap) {
        if (urlMap.hasOwnProperty(origUrl)) {
            var escaped = origUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            text = text.replace(new RegExp(escaped, 'g'), urlMap[origUrl]);
        }
    }
    return text;
}

/* ============================================================
   Expand used codepoints to cover full character ranges.
   If any character in a range is used, include the whole range.
   Only includes codepoints that exist in the font's cmap.
   ============================================================ */

var expandRanges = [
    [0x21, 0x7E],    /* ASCII printable */
    [0xC0, 0xFF],    /* Latin-1 Supplement letters */
    [0x100, 0x17F],  /* Latin Extended-A */
    [0x180, 0x24F],  /* Latin Extended-B */
    [0x370, 0x3FF],  /* Greek and Coptic */
    [0x400, 0x4FF],  /* Cyrillic */
    [0x590, 0x5FF],  /* Hebrew */
    [0x600, 0x6FF]   /* Arabic */
];

function expandUsedCodepoints(usedCps, classifiedCmap) {
    /* Build set of all codepoints in the font */
    var inFont = {};
    var groups = ['ltr', 'rtl', 'neutral'];
    for (var gi = 0; gi < groups.length; gi++) {
        var keys = Object.keys(classifiedCmap[groups[gi]]);
        for (var ki = 0; ki < keys.length; ki++)
            inFont[parseInt(keys[ki])] = true;
    }

    /* For each range, check if any codepoint is used */
    for (var ri = 0; ri < expandRanges.length; ri++) {
        var lo = expandRanges[ri][0], hi = expandRanges[ri][1];
        var anyUsed = false;
        for (var cp = lo; cp <= hi; cp++) {
            if (usedCps[cp]) { anyUsed = true; break; }
        }
        if (anyUsed) {
            for (var cp = lo; cp <= hi; cp++) {
                if (inFont[cp]) usedCps[cp] = true;
            }
        }
    }

    return usedCps;
}

/* ============================================================
   Build multi-mapping for one font.
   ============================================================ */

function buildMultiMapping(classifiedCmap, usedCps, seed, excludePool) {
    var rng = new JsRng(seed);
    var groups = ['ltr', 'rtl', 'neutral'];
    var mapping = {};
    var cmapEntries = [];

    for (var gi = 0; gi < groups.length; gi++) {
        var groupName = groups[gi];
        var groupCmap = classifiedCmap[groupName];
        var groupKeys = Object.keys(groupCmap);

        var usedInGroup = [];
        var pool = [];
        for (var ki = 0; ki < groupKeys.length; ki++) {
            var cp = parseInt(groupKeys[ki]);
            if (excludePool && excludePool[cp]) continue;
            pool.push(cp);
            if (usedCps[cp])
                usedInGroup.push(cp);
        }

        if (usedInGroup.length === 0 || pool.length === 0) continue;

        for (var i = pool.length - 1; i > 0; i--) {
            var j = rng.randInt(i + 1);
            var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
        }

        var aliasCount = Math.floor(pool.length / usedInGroup.length);
        if (aliasCount < 1) aliasCount = 1;
        var poolIdx = 0;

        for (var ui = 0; ui < usedInGroup.length; ui++) {
            var origCp = usedInGroup[ui];
            var glyphID = groupCmap[String(origCp)];
            var aliases = [];

            var count = (ui < usedInGroup.length - 1) ? aliasCount : (pool.length - poolIdx);
            for (var ai = 0; ai < count && poolIdx < pool.length; ai++, poolIdx++) {
                aliases.push(pool[poolIdx]);
                cmapEntries.push([pool[poolIdx], glyphID]);
            }

            mapping[String(origCp)] = aliases;
        }
    }

    return { mapping: mapping, cmapArray: cmapEntries };
}

/* ============================================================
   Apply an existing multi mapping to a different font.
   For each alias codepoint in the mapping, look up the
   original character's glyphID in this font's cmap.
   ============================================================ */

function applyMultiMapping(classifiedCmap, existingMapping) {
    /* Build a lookup: origCp -> glyphID from this font */
    var cpToGlyph = {};
    var groups = ['ltr', 'rtl', 'neutral'];
    for (var gi = 0; gi < groups.length; gi++) {
        var groupCmap = classifiedCmap[groups[gi]];
        var keys = Object.keys(groupCmap);
        for (var ki = 0; ki < keys.length; ki++)
            cpToGlyph[keys[ki]] = groupCmap[keys[ki]];
    }

    var cmapEntries = [];
    var mapKeys = Object.keys(existingMapping);
    for (var i = 0; i < mapKeys.length; i++) {
        var origCp = mapKeys[i];
        var glyphID = cpToGlyph[origCp];
        if (glyphID === undefined) continue; /* this font doesn't have this character */
        var aliases = existingMapping[origCp];
        for (var j = 0; j < aliases.length; j++) {
            cmapEntries.push([aliases[j], glyphID]);
        }
    }

    return cmapEntries;
}

/* ============================================================
   Find fonts in HTML.
   ============================================================ */

function findFontsInHtml(htmlText, baseDir) {
    var doc = htmlmod.newDocument(htmlText, { dropEmptyElements: false });
    var allFontUrls = [];

    var importHrefs = [];  /* track @import URLs that contain fonts */
    var styleTags = doc.findTag("style");
    if (styleTags.length > 0) {
        var styleTexts = styleTags.toHtml();
        for (var si = 0; si < styleTexts.length; si++) {
            var content = styleTexts[si].replace(/^<style[^>]*>/i, '').replace(/<\/style>$/i, '');
            /* Check for inline @font-face */
            var found = extractFontUrls(content);
            for (var fi = 0; fi < found.length; fi++)
                allFontUrls.push(found[fi]);
            /* Check for @import url(...) */
            var importRe = /@import\s+url\(\s*['"]?([^'")]+?)['"]?\s*\)/g;
            var importMatch;
            while ((importMatch = importRe.exec(content)) !== null) {
                var importUrl = importMatch[1];
                var importCss;
                if (/^https?:\/\//.test(importUrl)) {
                    try {
                        var res = curl.fetch(importUrl);
                        if (res.status === 200)
                            importCss = rampart.utils.bufferToString(res.body);
                        else
                            throw new Error("fontshuffle: @import fetch returned status " + res.status + ": " + importUrl);
                    } catch(e) {
                        if (e.message && e.message.indexOf("fontshuffle:") === 0) throw e;
                        throw new Error("fontshuffle: could not fetch @import: " + importUrl + " (" + (e.message || e) + ")");
                    }
                } else {
                    var importPath = importUrl.charAt(0) === '/'
                        ? importUrl : baseDir + '/' + importUrl;
                    importCss = rampart.utils.readFile(importPath, true);
                    if (!importCss)
                        throw new Error("fontshuffle: could not read @import file: " + importPath);
                }
                if (importCss) {
                    var importBaseDir = /^https?:\/\//.test(importUrl)
                        ? importUrl.replace(/\/[^\/]*$/, '') : baseDir;
                    var importFonts = extractFontUrls(importCss);
                    if (importFonts.length > 0) {
                        /* Decode HTML entities that rampart-html may have added */
                        importHrefs.push(importUrl.replace(/&amp;/g, '&'));
                        for (var fi = 0; fi < importFonts.length; fi++) {
                            if (!importFonts[fi].isRemote && /^https?:\/\//.test(importUrl)) {
                                importFonts[fi].url = importBaseDir + '/' + importFonts[fi].url;
                                importFonts[fi].isRemote = true;
                            }
                            importFonts[fi].fromExternal = true;
                            allFontUrls.push(importFonts[fi]);
                        }
                    }
                }
            }
        }
    }

    var linkTags = doc.findTag("link");
    var fontLinkHrefs = [];  /* track <link> tags that contain fonts, to remove later */
    if (linkTags.length > 0) {
        var linkAttrs = linkTags.getAllAttr();
        for (var li = 0; li < linkAttrs.length; li++) {
            var la = linkAttrs[li];
            if (la.rel && la.rel.toLowerCase() === 'stylesheet' && la.href) {
                var cssText;
                if (/^https?:\/\//.test(la.href)) {
                    try {
                        var res = curl.fetch(la.href);
                        if (res.status === 200)
                            cssText = rampart.utils.bufferToString(res.body);
                        else
                            throw new Error("fontshuffle: stylesheet fetch returned status " + res.status + ": " + la.href);
                    } catch(e) {
                        if (e.message && e.message.indexOf("fontshuffle:") === 0) throw e;
                        throw new Error("fontshuffle: could not fetch stylesheet: " + la.href + " (" + (e.message || e) + ")");
                    }
                } else {
                    var cssPath = la.href.charAt(0) === '/'
                        ? la.href : baseDir + '/' + la.href;
                    cssText = rampart.utils.readFile(cssPath, true);
                    if (!cssText)
                        throw new Error("fontshuffle: could not read stylesheet: " + cssPath);
                }
                if (cssText) {
                    var cssBaseDir;
                    if (/^https?:\/\//.test(la.href))
                        cssBaseDir = la.href.replace(/\/[^\/]*$/, '');
                    else {
                        var cssPath2 = la.href.charAt(0) === '/'
                            ? la.href : baseDir + '/' + la.href;
                        cssBaseDir = cssPath2.replace(/\/[^\/]*$/, '');
                    }
                    var found = extractFontUrls(cssText);
                    if (found.length > 0) {
                        fontLinkHrefs.push(la.href);
                        for (var fi = 0; fi < found.length; fi++) {
                            if (!found[fi].isRemote && /^https?:\/\//.test(la.href)) {
                                found[fi].url = cssBaseDir + '/' + found[fi].url;
                                found[fi].isRemote = true;
                            } else if (!found[fi].isRemote) {
                                found[fi].localBaseDir = cssBaseDir;
                            }
                            found[fi].fromExternal = true;
                            allFontUrls.push(found[fi]);
                        }
                    }
                }
            }
        }
    }

    doc.destroy();

    var seen = {};
    var unique = [];
    for (var i = 0; i < allFontUrls.length; i++) {
        if (!seen[allFontUrls[i].url]) {
            seen[allFontUrls[i].url] = true;
            unique.push(allFontUrls[i]);
        }
    }

    return { fonts: unique, fontLinkHrefs: fontLinkHrefs, importHrefs: importHrefs };
}

/* ============================================================
   Apply guard: rewrite HTML to defer font loading until a
   client-side detection script confirms a human browser.

   guard options:
     src:   URL of the detection script (loaded via <script>)
     check: JS expression that evaluates to true if human
            (e.g. "detectHeadless().isHeadless < 0.3")
   ============================================================ */

/* ============================================================
   Obfuscate mailto: and tel: hrefs.
   Replaces href="mailto:..." with href="#" data-ws-m="encoded"
   and href="tel:..." with href="#" data-ws-t="encoded".
   Encoding: XOR each byte with (seed % 256), then base64.
   ============================================================ */

function obfuscateMailtoTel(html, seed) {
    var xorKey = seed % 256;
    var count = 0;

    function encode(str) {
        var bytes = [];
        for (var i = 0; i < str.length; i++)
            bytes.push(str.charCodeAt(i) ^ xorKey);
        /* Manual base64 encode */
        var b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        var out = "";
        for (var i = 0; i < bytes.length; i += 3) {
            var b0 = bytes[i], b1 = bytes[i+1] || 0, b2 = bytes[i+2] || 0;
            out += b64[(b0 >> 2)];
            out += b64[((b0 & 3) << 4) | (b1 >> 4)];
            out += (i+1 < bytes.length) ? b64[((b1 & 15) << 2) | (b2 >> 6)] : "=";
            out += (i+2 < bytes.length) ? b64[(b2 & 63)] : "=";
        }
        return out;
    }

    /* Match href="mailto:..." or href='mailto:...' */
    var result = html.replace(
        /href\s*=\s*(['"])(mailto:)([^'"]+)\1/gi,
        function(match, quote, prefix, addr) {
            count++;
            return 'href=' + quote + '#' + quote + ' data-ws-m="' + encode(addr) + '"';
        }
    );

    /* Match href="tel:..." or href='tel:...' */
    result = result.replace(
        /href\s*=\s*(['"])(tel:)([^'"]+)\1/gi,
        function(match, quote, prefix, number) {
            count++;
            return 'href=' + quote + '#' + quote + ' data-ws-t="' + encode(number) + '"';
        }
    );

    return { html: result, count: count };
}

function applyGuard(html, fontUrlMap, guard, hasImages, hasMailto) {
    var delay = (guard && typeof guard.delay === 'number') ? guard.delay : 500;

    /* Extract @font-face blocks: capture font-family and the new font URL.
       Then remove the entire @font-face block from the CSS so the browser
       never tries to load the font until the guard script injects it. */
    var guarded = html;
    var fontFaces = [];

    for (var origUrl in fontUrlMap) {
        if (!fontUrlMap.hasOwnProperty(origUrl)) continue;
        var newUrl = fontUrlMap[origUrl];
        var escaped = newUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        var ffRe = new RegExp('@font-face\\s*\\{[^}]*' + escaped + '[^}]*\\}', 'g');
        var match;
        while ((match = ffRe.exec(guarded)) !== null) {
            var block = match[0];
            var famMatch = block.match(/font-family:\s*['"]?([^'";]+)/);
            var family = famMatch ? famMatch[1].replace(/\s+$/, '') : 'ShieldFont';
            var fmtMatch = block.match(/format\(\s*['"]?([^'")]+)/);
            var format = fmtMatch ? fmtMatch[1] : 'truetype';
            fontFaces.push({ family: family, url: newUrl, format: format });
        }
        guarded = guarded.replace(ffRe, '/* font guarded */');
    }

    if (fontFaces.length === 0) return html;

    var fontFaceCss = '';
    for (var i = 0; i < fontFaces.length; i++) {
        var ff = fontFaces[i];
        fontFaceCss += "@font-face{font-family:'" + ff.family +
            "';src:url('" + ff.url + "') format('" + ff.format + "');}";
    }

    /* Build the guard script from readable parts, then minify */
    var parts = [];
    parts.push('(function(){');

    /* loadFonts function */
    parts.push('function loadFonts(){');
    parts.push('var s=document.createElement("style");');
    parts.push('s.textContent=' + JSON.stringify(fontFaceCss) + ';');
    parts.push('document.head.appendChild(s);');
    parts.push('document.fonts.ready.then(function(){document.body.style.opacity="1"});');

    /* Image unscramble (inside loadFonts) — strip script tags and IIFE wrapper */
    if (hasImages) {
        var rawUnscramble = clientUnscrambleScript;
        /* Strip <script> tags */
        rawUnscramble = rawUnscramble.replace(/^<script>/, '').replace(/<\/script>$/, '');
        /* Strip IIFE wrapper: leading (function(){ and trailing })(); */
        rawUnscramble = rawUnscramble.replace(/^\(function\(\)\{/, '');
        rawUnscramble = rawUnscramble.replace(/\}\)\(\);\s*$/, '');
        parts.push(rawUnscramble + ';');
    }

    /* Mailto/tel decoder (inside loadFonts) */
    if (hasMailto) {
        parts.push('var xk=' + (seed % 256) + ';');
        parts.push('function dc(v){var s=atob(v),o="";for(var i=0;i<s.length;i++)o+=String.fromCharCode(s.charCodeAt(i)^xk);return o}');
        parts.push('var ml=document.querySelectorAll("[data-ws-m]");for(var i=0;i<ml.length;i++){(function(el){el.addEventListener("click",function(ev){ev.preventDefault();window.location.href="mailto:"+dc(el.getAttribute("data-ws-m"))})})(ml[i])}');
        parts.push('var tl=document.querySelectorAll("[data-ws-t]");for(var i=0;i<tl.length;i++){(function(el){el.addEventListener("click",function(ev){ev.preventDefault();window.location.href="tel:"+dc(el.getAttribute("data-ws-t"))})})(tl[i])}');
    }

    parts.push('}');  /* end loadFonts */

    /* show function */
    parts.push('function show(){document.body.style.opacity="1"}');

    /* CDP Proxy trap */
    parts.push('var cdp=false;');
    parts.push('try{var t=new Proxy({},{ownKeys:function(){cdp=true;return[]}});console.groupEnd(Object.create(t))}catch(e){}');
    parts.push('if(cdp){show()}else{setTimeout(function(){loadFonts()},' + delay + ')}');

    parts.push('})();');

    /* Join and wrap in script tag */
    var guardScript = '\n<style>body{opacity:0;transition:opacity 0.15s}</style>\n' +
        '<script>' + parts.join('') + '<\/script>\n';

    var bodyClose = guarded.lastIndexOf('</body>');
    if (bodyClose === -1) bodyClose = guarded.lastIndexOf('</html>');
    if (bodyClose === -1) bodyClose = guarded.length;

    guarded = guarded.substring(0, bodyClose) + guardScript + guarded.substring(bodyClose);

    return guarded;
}

/* ============================================================
   Main function: fontshuffle(html, seed [, options])
   ============================================================ */

function fontshuffle(webpage, seed, options) {
    if (typeof webpage !== 'string')
        throw new Error("fontshuffle: first argument must be a String (HTML text or filename)");
    if (typeof seed !== 'number' || seed < 0)
        throw new Error("fontshuffle: second argument must be a non-negative number (seed)");

    options = options || {};
    var mode = options.mode || "simple";
    var existingMappings = options.mappings || null;

    var htmlText;
    var baseDir = '.';
    if (/^\s*</.test(webpage)) {
        htmlText = webpage;
    } else {
        htmlText = rampart.utils.readFile(webpage, true);
        if (!htmlText)
            throw new Error("fontshuffle: could not read file: " + webpage);
        baseDir = webpage.replace(/\/[^\/]*$/, '');
        if (baseDir === webpage) baseDir = '.';
    }

    var fontSearch = findFontsInHtml(htmlText, baseDir);
    var uniqueFonts = fontSearch.fonts;
    var fontLinkHrefs = fontSearch.fontLinkHrefs;
    var importHrefs = fontSearch.importHrefs;
    if (uniqueFonts.length === 0)
        throw new Error(
            "fontshuffle: no font files found in @font-face declarations.\n\n" +
            "rampart-webshield requires the page to use a web font via @font-face.\n" +
            "Add something like this to your <style> block:\n\n" +
            "    @font-face {\n" +
            "        font-family: 'MyFont';\n" +
            "        src: url('https://fonts.gstatic.com/s/inter/v20/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfMZg.ttf') format('truetype');\n" +
            "    }\n" +
            "    body { font-family: 'MyFont', sans-serif; }\n"
        );

    var combinedMapping = {};
    var fontUrlMap = {};
    var outputFonts = [];
    var outputMappings = {};
    var warnings = [];
    var isMulti = (mode === "multi");

    for (var i = 0; i < uniqueFonts.length; i++) {
        var fi = uniqueFonts[i];

        /* Check for existing mapping */
        if (existingMappings && existingMappings[fi.url]) {
            var saved = existingMappings[fi.url];
            if (!saved.fontFile)
                throw new Error("fontshuffle: mappings for " + fi.url + " missing fontFile");
            if (!saved.map || Object.keys(saved.map).length === 0)
                throw new Error("fontshuffle: mappings for " + fi.url + " has no map data");
            /* Verify fontFile name matches what we'd generate */
            var expectedName = obfuscatedName(fi.url, seed);
            if (saved.fontFile !== expectedName)
                throw new Error("fontshuffle: mappings fontFile '" + saved.fontFile +
                    "' does not match expected '" + expectedName + "' for " + fi.url);
            var m = saved.map;
            isMulti = (saved.mode === "multi");
            fontUrlMap[fi.url] = saved.fontFile;
            outputMappings[fi.url] = saved;
            var keys = Object.keys(m);
            for (var k = 0; k < keys.length; k++) {
                if (combinedMapping[keys[k]] === undefined)
                    combinedMapping[keys[k]] = m[keys[k]];
            }
            continue;
        }

        var newName = obfuscatedName(fi.url, seed);
        fontUrlMap[fi.url] = newName;

        /* Load font */
        var fontBaseDir = fi.localBaseDir || baseDir;
        var fontBuf = loadFont(fi.url, fi.isRemote, fontBaseDir);
        if (!fontBuf)
            throw new Error("fontshuffle: could not load font: " + fi.url);

        var fontData, fontMapping;

        if (isMulti) {
            var classifiedCmap = fontshuffle_c.getCmap(fontBuf);
            var usedCps = expandUsedCodepoints(scanUsedCodepoints(htmlText), classifiedCmap);
            if (Object.keys(combinedMapping).length > 0) {
                /* Subsequent font: reuse existing mapping where possible,
                   build supplementary mapping for character groups this
                   font covers that the first font didn't. */
                var cmapArray = applyMultiMapping(classifiedCmap, combinedMapping);

                /* Check for used characters this font has but the mapping doesn't cover */
                var supplementNeeded = {};
                var usedKeys = Object.keys(usedCps);
                for (var uk = 0; uk < usedKeys.length; uk++) {
                    var ucp = usedKeys[uk];
                    if (combinedMapping[ucp] === undefined) {
                        /* Check if this font has it */
                        var groups = ['ltr', 'rtl', 'neutral'];
                        for (var gi = 0; gi < groups.length; gi++) {
                            if (classifiedCmap[groups[gi]][ucp] !== undefined)
                                supplementNeeded[ucp] = true;
                        }
                    }
                }

                if (Object.keys(supplementNeeded).length > 0) {
                    /* Build exclude set: all alias codepoints already used */
                    var excludePool = {};
                    var cmKeys = Object.keys(combinedMapping);
                    for (var ci = 0; ci < cmKeys.length; ci++) {
                        var aliases = combinedMapping[cmKeys[ci]];
                        for (var ai = 0; ai < aliases.length; ai++)
                            excludePool[aliases[ai]] = true;
                    }
                    var supplement = buildMultiMapping(classifiedCmap, supplementNeeded, seed, excludePool);
                    cmapArray = cmapArray.concat(supplement.cmapArray);
                    fontMapping = {};
                    var ck = Object.keys(combinedMapping);
                    for (var ci = 0; ci < ck.length; ci++)
                        fontMapping[ck[ci]] = combinedMapping[ck[ci]];
                    var sk = Object.keys(supplement.mapping);
                    for (var si = 0; si < sk.length; si++)
                        fontMapping[sk[si]] = supplement.mapping[sk[si]];
                } else {
                    fontMapping = combinedMapping;
                }

                fontData = fontshuffle_c.buildFont(fontBuf, cmapArray);
            } else {
                /* First font: build the mapping */
                var mm = buildMultiMapping(classifiedCmap, usedCps, seed);
                fontData = fontshuffle_c.buildFont(fontBuf, mm.cmapArray);
                fontMapping = mm.mapping;
            }
        } else {
            var result = fontshuffle_c.obfuscateFont(fontBuf, seed);
            fontData = result.font;
            fontMapping = result.mapping;
        }

        outputFonts.push({ name: newName, data: fontData });
        outputMappings[fi.url] = { mode: mode, fontFile: newName, map: fontMapping };

        var keys = Object.keys(fontMapping);
        for (var k = 0; k < keys.length; k++) {
            if (combinedMapping[keys[k]] === undefined)
                combinedMapping[keys[k]] = fontMapping[keys[k]];
        }
    }

    /* Check for characters used in HTML but missing from mappings.
       Skip codepoints that are intentionally unshuffled (whitespace, control). */
    var usedInHtml = scanUsedCodepoints(htmlText);
    var missing = [];
    var usedKeys = Object.keys(usedInHtml);
    for (var i = 0; i < usedKeys.length; i++) {
        var ucp = parseInt(usedKeys[i]);
        if (combinedMapping[usedKeys[i]] === undefined &&
            ucp > 0x20 && ucp !== 0xA0 && ucp !== 0xAD &&
            !(ucp >= 0x7F && ucp <= 0x9F))
            missing.push(ucp);
    }
    if (missing.length > 0) {
        var samples = missing.slice(0, 10).map(function(cp) {
            return 'U+' + cp.toString(16).toUpperCase() +
                   ' (' + String.fromCharCode(cp) + ')';
        });
        warnings.push("" + missing.length + " character(s) in the HTML have no mapping" +
            (existingMappings ? " — regenerate the font to include them" : "") +
            ": " + samples.join(', ') + (missing.length > 10 ? ', ...' : ''));
    }

    /* Inject comment and notranslate meta tag */
    var headTag = htmlText.indexOf('<head');
    var headEnd = htmlText.indexOf('>', headTag);
    if (headTag >= 0 && headEnd >= 0) {
        htmlText = htmlText.substring(0, headEnd + 1) +
            '\n<!-- Obfuscated with rampart-webshield - https://github.com/aflin/rampart_webshield/ -->' +
            '\n<meta name="google" content="notranslate">' +
            htmlText.substring(headEnd + 1);
    }

    /* Handle font CSS injection.
       - For inline <style> @font-face: replace URLs directly (no conflict)
       - For external <link> @font-face: keep the <link> (original fonts for
         no-scramble zones), inject scrambled fonts with 'ws-' prefixed names,
         and add 'ws-scrambled' class to elements outside no-scramble zones */
    var cleanedHtml = htmlText;
    var hasExternalFonts = fontLinkHrefs.length > 0 || importHrefs.length > 0;

    if (hasExternalFonts) {
        /* Build inline @font-face rules with ws- prefixed font-family names */
        var inlineFontCss = '';
        var wsFamilies = {};  /* track unique ws- family names */
        var origFamilies = {};  /* track original family names (external only) */
        for (var i = 0; i < uniqueFonts.length; i++) {
            var fi = uniqueFonts[i];
            if (fi.cssBlock && fontUrlMap[fi.url]) {
                var block = fi.cssBlock;
                /* Replace the URL */
                var escapedUrl = fi.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                block = block.replace(new RegExp(escapedUrl, 'g'), fontUrlMap[fi.url]);
                /* Rename font-family to ws- prefix */
                block = block.replace(
                    /font-family:\s*['"]([^'"]+)['"]/,
                    function(match, name) {
                        var wsName = 'ws-' + name;
                        wsFamilies[wsName] = true;
                        if (fi.fromExternal) origFamilies[name] = true;
                        return "font-family:'" + wsName + "'";
                    }
                );
                inlineFontCss += block + '\n';
            }
        }

        /* Build CSS rules: ws-scrambled uses ws- fonts, no-scramble resets to originals */
        var wsFamilyList = Object.keys(wsFamilies).map(function(n) { return "'" + n + "'"; }).join(',');
        var origFamilyList = Object.keys(origFamilies).map(function(n) { return "'" + n + "'"; }).join(',');
        if (wsFamilyList) {
            inlineFontCss += '.ws-scrambled,.ws-scrambled *{font-family:' + wsFamilyList + ',sans-serif!important}\n';
            inlineFontCss += '[data-no-scramble][data-no-scramble][data-no-scramble],[data-no-scramble][data-no-scramble][data-no-scramble] *{font-family:' + origFamilyList + ',sans-serif!important}\n';
            inlineFontCss += '[data-scramble],[data-scramble] *{font-family:' + wsFamilyList + ',sans-serif!important}\n';
        }

        /* Inject the CSS before </head> */
        if (inlineFontCss) {
            var headClose = cleanedHtml.indexOf('</head>');
            if (headClose === -1) headClose = cleanedHtml.indexOf('<body');
            if (headClose === -1) headClose = 0;
            cleanedHtml = cleanedHtml.substring(0, headClose) +
                '<style>\n' + inlineFontCss + '</style>\n' +
                cleanedHtml.substring(headClose);
        }

        /* Remove @import lines before DOM walk (prettyPrint would restore them) */
        for (var ii = 0; ii < importHrefs.length; ii++) {
            /* Build regex that matches both & and &amp; variants */
            var escaped = importHrefs[ii].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/&/g, '(?:&|&amp;)');
            cleanedHtml = cleanedHtml.replace(
                new RegExp('@import\\s+url\\(\\s*[\'"]?' + escaped + '[\'"]?\\s*\\)[^;]*;?', 'gi'),
                '/* import removed by webshield */');
        }

        /* Walk DOM: add ws-scrambled class to body children not inside data-no-scramble */
        var doc2 = htmlmod.newDocument(cleanedHtml, { dropEmptyElements: false });
        var body = doc2.findTag("body");
        if (body.length > 0) {
            var bodyChildren = body.children();
            var noScrambleFlags = bodyChildren.hasAttr("data-no-scramble");
            for (var ci = 0; ci < bodyChildren.length; ci++) {
                if (!noScrambleFlags[ci]) {
                    bodyChildren.eq(ci).addClass("ws-scrambled");
                }
            }
            cleanedHtml = doc2.prettyPrint({indent: false, wrap: 0});
        }
        doc2.destroy();

    } else {
        /* No external fonts — just update URLs in inline @font-face */
        cleanedHtml = updateFontUrls(cleanedHtml, fontUrlMap);
    }

    /* Update any remaining inline font URLs, then remap text */
    var updatedHtml = updateFontUrls(cleanedHtml, fontUrlMap);
    var obfuscatedHtml = remapHtmlText(updatedHtml, combinedMapping, isMulti);

    /* Process images if requested */
    var outputImages = [];
    var imgOpts = options.images ? (typeof options.images === 'object' ? options.images : {}) : null;
    var guard = options.guard ? (typeof options.guard === 'object' ? options.guard : {}) : null;
    if (imgOpts) {
        var imgResult = processImages(obfuscatedHtml, seed, null, baseDir, imgOpts, !!guard);
        obfuscatedHtml = imgResult.html;
        outputImages = imgResult.images;
        if (imgResult.warnings)
            for (var wi = 0; wi < imgResult.warnings.length; wi++)
                warnings.push(imgResult.warnings[wi]);
    }

    /* Obfuscate mailto: and tel: links */
    var hasMailto = false;
    var emailOpt = options.email || false;
    if (guard || emailOpt) {
        var mailResult = obfuscateMailtoTel(obfuscatedHtml, seed);
        obfuscatedHtml = mailResult.html;
        hasMailto = mailResult.count > 0;
        /* If no guard, inject standalone mailto decoder script */
        if (hasMailto && !guard) {
            var xorKey = seed % 256;
            var decoderScript = '\n<script>' +
                'var xk=' + xorKey + ';' +
                'function dc(v){var s=atob(v),o="";for(var i=0;i<s.length;i++)o+=String.fromCharCode(s.charCodeAt(i)^xk);return o}' +
                'var ml=document.querySelectorAll("[data-ws-m]");for(var i=0;i<ml.length;i++){(function(el){el.addEventListener("click",function(ev){ev.preventDefault();window.location.href="mailto:"+dc(el.getAttribute("data-ws-m"))})})(ml[i])}' +
                'var tl=document.querySelectorAll("[data-ws-t]");for(var i=0;i<tl.length;i++){(function(el){el.addEventListener("click",function(ev){ev.preventDefault();window.location.href="tel:"+dc(el.getAttribute("data-ws-t"))})})(tl[i])}' +
                '<\/script>\n';
            var bodyClose = obfuscatedHtml.lastIndexOf('</body>');
            if (bodyClose === -1) bodyClose = obfuscatedHtml.lastIndexOf('</html>');
            if (bodyClose === -1) bodyClose = obfuscatedHtml.length;
            obfuscatedHtml = obfuscatedHtml.substring(0, bodyClose) + decoderScript + obfuscatedHtml.substring(bodyClose);
        }
    } else {
        /* Warn if mailto/tel links are present but neither --guard nor --email is used */
        var mailtoCount = (obfuscatedHtml.match(/href\s*=\s*['"]mailto:/gi) || []).length;
        var telCount = (obfuscatedHtml.match(/href\s*=\s*['"]tel:/gi) || []).length;
        if (mailtoCount + telCount > 0)
            warnings.push("Found " + (mailtoCount + telCount) + " mailto/tel link(s) that are not obfuscated. Use --guard or --email to protect them.");
    }

    /* Apply guard if requested */
    if (guard) {
        obfuscatedHtml = applyGuard(obfuscatedHtml, fontUrlMap, guard, outputImages.length > 0, hasMailto);
    }

    return {
        text: obfuscatedHtml,
        fonts: outputFonts,
        images: outputImages,
        mappings: outputMappings,
        warnings: warnings
    };
}

/* ============================================================
   Image scrambling: tile shuffle using rampart-gm for I/O
   ============================================================ */

var gm;
try { gm = require("rampart-gm"); } catch(e) { gm = null; }

/*
    Parse a PPM (P6) buffer: extract width, height, and pixel data offset.
*/
function parsePPM(buf) {
    var s = rampart.utils.bufferToString(buf);
    /* P6\nWIDTH HEIGHT\nMAXVAL\n */
    var i = 0;
    if (s.charAt(0) !== 'P' || s.charAt(1) !== '6')
        throw new Error("parsePPM: not a P6 PPM");
    i = s.indexOf('\n', 0) + 1;
    /* Skip comments */
    while (s.charAt(i) === '#')
        i = s.indexOf('\n', i) + 1;
    var dims = s.substring(i, s.indexOf('\n', i)).split(/\s+/);
    var width = parseInt(dims[0]);
    var height = parseInt(dims[1]);
    i = s.indexOf('\n', i) + 1;
    /* maxval line */
    i = s.indexOf('\n', i) + 1;
    return { width: width, height: height, dataOffset: i };
}

/*
    Build a PPM buffer from raw RGB pixel data.
*/
function buildPPM(width, height, rgbBuf) {
    var header = "P6\n" + width + " " + height + "\n255\n";
    var headerBuf = rampart.utils.stringToBuffer(header);
    return rampart.utils.abprintf(headerBuf, "%s", rgbBuf);
}

/*
    scrambleImage(image, seed [, options])

    Parameters:
        image   - String: file path, or Buffer: image data
        seed    - Number: PRNG seed
        options - Object (optional):
            tileSize: Number (default 32)
            format:   String output format (default: same as input, or "PNG")

    Returns: {
        image:    Buffer (scrambled image in output format),
        format:   String (e.g. "PNG", "JPEG"),
        width:    Number,
        height:   Number,
        tileSize: Number
    }
*/
function scrambleImage(image, seed, options) {
    if (!gm)
        throw new Error("scrambleImage: rampart-gm is required (install libgraphicsmagick)");

    options = options || {};
    var tileSize = options.tileSize || 32;

    /* Load image */
    var img;
    if (typeof image === 'string') {
        if (/^https?:\/\//.test(image)) {
            var res = curl.fetch(image);
            if (res.status !== 200 || !res.body)
                throw new Error("scrambleImage: could not fetch " + image);
            /* Write to temp file for gm */
            var tmp = "/tmp/ws_img_" + process.getpid() + ".tmp";
            rampart.utils.fprintf(tmp, "%s", res.body);
            img = gm.open(tmp);
            rampart.utils.rmFile(tmp);
        } else {
            img = gm.open(image);
        }
    } else if (image && image.length) {
        /* Buffer - write to temp file */
        var tmp = "/tmp/ws_img_" + process.getpid() + ".tmp";
        rampart.utils.fprintf(tmp, "%s", image);
        img = gm.open(tmp);
        rampart.utils.rmFile(tmp);
    } else {
        throw new Error("scrambleImage: image must be a file path or Buffer");
    }

    var info = img.identify();
    var width = info.width;
    var height = info.height;
    var origFormat = info.magick; /* "JPEG", "PNG", etc. */

    /* Convert to raw PPM pixels */
    var ppmBuf = img.toBuffer("PPM");
    var ppm = parsePPM(ppmBuf);

    /* Extract raw RGB pixels by writing PPM to temp, reading back with offset */
    var tmpPpm = "/tmp/ws_ppm_" + process.getpid() + ".ppm";
    rampart.utils.fprintf(tmpPpm, "%s", ppmBuf);
    var rgbBuf = rampart.utils.readFile(tmpPpm, ppm.dataOffset, width * height * 3);
    rampart.utils.rmFile(tmpPpm);

    /* Shuffle tiles using C module (handles padding internally) */
    var shuffled = fontshuffle_c.shuffleTiles(rgbBuf, width, height, tileSize, seed);

    /* The C function pads to tile multiples and returns padded dimensions */
    var padW = Math.ceil(width / tileSize) * tileSize;
    var padH = Math.ceil(height / tileSize) * tileSize;

    /* Rebuild PPM with padded dimensions and convert to output format */
    var outPPM = buildPPM(padW, padH, shuffled);

    /* Write temp PPM, open with gm, convert to output format */
    var outFormat = options.format || origFormat || "PNG";
    var tmpOut = "/tmp/ws_shuf_" + process.getpid() + ".ppm";
    rampart.utils.fprintf(tmpOut, "%s", outPPM);
    var outImg = gm.open(tmpOut);
    var outBuf = outImg.toBuffer(outFormat);
    outImg.close();
    rampart.utils.rmFile(tmpOut);

    return {
        image: outBuf,
        format: outFormat,
        width: width,
        height: height,
        tileSize: tileSize
    };
}

/* ============================================================
   Client-side unscramble script (injected into HTML).
   Contains the xorshift64 PRNG and tile-unshuffle logic.
   ============================================================ */

var clientUnscrambleScript = '<script>' +
'(function(){function _a(b){var c=(b/0x100000000)>>>0,d=b>>>0;if(!c&&!d){c=0xFEE1BADC;d=0xEEDBA110}return{next:function(){var e;e=(c<<13)|(d>>>19);d^=d<<13;c^=e;e=c>>>7;d^=(d>>>7)|(c<<25);c^=e;e=(c<<17)|(d>>>15);d^=d<<17;c^=e;c=c>>>0;d=d>>>0;return{hi:c,lo:d}},mod:function(f){var g=this.next();return((g.hi%f)*(4294967296%f)%f+g.lo%f)%f}}}' +
'function _b(h,i,j,k,l,m){var n=Math.ceil(j/l),o=Math.ceil(k/l),p=n*o,q=[],r;for(r=0;r<p;r++)q[r]=r;var s=_a(m);for(r=p-1;r>0;r--){var t=s.mod(r+1),u=q[r];q[r]=q[t];q[t]=u}var v=i.getContext("2d");for(r=0;r<p;r++){var w=q[r],x=(r%n)*l,y=Math.floor(r/n)*l,z=(w%n)*l,A=Math.floor(w/n)*l,B=Math.min(l,j-x),C=Math.min(l,k-y),D=Math.min(l,j-z),E=Math.min(l,k-A),F=Math.min(B,D),G=Math.min(C,E);v.drawImage(h,x,y,F,G,z,A,F,G)}}' +
'function _w(_e,_f,_g,_h,_i){var _k=_e.naturalWidth||_e.width,_l=_e.naturalHeight||_e.height;if(!_k||!_l)return;var _m=document.createElement("canvas");_m.width=_h||_k;_m.height=_i||_l;var _n=document.createElement("div");_n.style.position="relative";_n.style.display="inline-block";_n.style.cssText+=_e.style.cssText;_n.className=_e.className;_m.setAttribute("data-ws-canvas","1");_m.style.width="100%";_m.style.height="auto";_m.style.display="block";_e.parentNode.insertBefore(_n,_e);_n.appendChild(_m);_n.appendChild(_e);_e.style.cssText="position:absolute;top:0;left:0;width:100%;height:100%;opacity:0";' +
'var _iv=setInterval(function(){_b(_e,_m,_k,_l,_f,_g);try{var _p=_m.getContext("2d").getImageData(0,0,1,1).data;if(_p[3]>0)clearInterval(_iv)}catch(_x){clearInterval(_iv)}},100)}' +
'var _c=document.querySelectorAll("img[data-ws-scrambled]");for(var _d=0;_d<_c.length;_d++){(function(_e){var _f=parseInt(_e.getAttribute("data-ws-tile"))||32,_g=parseInt(_e.getAttribute("data-ws-seed"))||0,_h=parseInt(_e.getAttribute("data-ws-origw"))||0,_i=parseInt(_e.getAttribute("data-ws-origh"))||0;if(_e.complete&&_e.naturalWidth)_w(_e,_f,_g,_h,_i);else _e.addEventListener("load",function(){_w(_e,_f,_g,_h,_i)})})(_c[_d])}' +
'function _z(){var _r=document.querySelectorAll("canvas[data-ws-canvas]");for(var _s=0;_s<_r.length;_s++){_r[_s].getContext("2d").clearRect(0,0,_r[_s].width,_r[_s].height);_r[_s].remove()}var _t=document.querySelectorAll("img[data-ws-scrambled]");for(var _s=0;_s<_t.length;_s++){_t[_s].style.cssText="";_t[_s].style.width="100%"}}' +
'setInterval(function(){var _o=false;try{var _p=new Proxy({},{ownKeys:function(){_o=true;return[]}});console.groupEnd(Object.create(_p))}catch(_q){}if(_o){_z();return}var _t1=performance.now();(function(){debugger})();if(performance.now()-_t1>10)_z()},250)})();' +
'<\/script>';

/* ============================================================
   Process <img> tags in HTML for image scrambling.
   ============================================================ */

function processImages(html, seed, outputDir, baseDir, options, skipScript) {
    if (!gm) return { html: html, images: [], warnings: ["rampart-gm not available, skipping images"] };

    var tileSize = (options && options.tileSize) || 32;
    var images = [];
    var warnings = [];

    /* Build list of no-scramble ranges using HtmlWalker */
    var noScrambleRanges = [];
    var nsw = new HtmlWalker(html);
    var nsStart = -1;
    while (nsw.i < nsw.len) {
        var ch = nsw.str.charAt(nsw.i);
        if (ch === '<') {
            nsw.inTag = true;
            nsw.tagBuf = ch;
            nsw.i++; continue;
        }
        if (nsw.inTag) {
            nsw.tagBuf += ch;
            if (ch === '>') {
                var wasProt = nsw.zoneStack.length > 0 && nsw.zoneStack[nsw.zoneStack.length-1].protect;
                nsw.analyzeTag();
                nsw.inTag = false;
                nsw.tagBuf = '';
                var isProt = nsw.zoneStack.length > 0 && nsw.zoneStack[nsw.zoneStack.length-1].protect;
                if (!wasProt && isProt) nsStart = nsw.i + 1;
                if (wasProt && !isProt) noScrambleRanges.push([nsStart, nsw.i]);
            }
            nsw.i++; continue;
        }
        nsw.i++;
    }

    function isInNoScrambleZone(pos) {
        for (var ri = 0; ri < noScrambleRanges.length; ri++) {
            if (pos >= noScrambleRanges[ri][0] && pos <= noScrambleRanges[ri][1])
                return true;
        }
        return false;
    }

    /* Find <img> tags with src attributes */
    var imgRe = /<img\s[^>]*src\s*=\s*['"]([^'"]+)['"][^>]*>/gi;
    var match;
    var replacements = [];

    while ((match = imgRe.exec(html)) !== null) {
        var fullTag = match[0];
        var src = match[1];

        /* Skip data URIs, already-scrambled, and images in no-scramble zones */
        if (/^data:/.test(src)) continue;
        if (/data-ws-scrambled/.test(fullTag)) continue;
        if (isInNoScrambleZone(match.index)) continue;

        try {
            var result = scrambleImage(
                /^https?:\/\//.test(src) ? src : (baseDir + '/' + src),
                seed, { tileSize: tileSize }
            );

            var ext = result.format.toLowerCase();
            if (ext === 'jpeg') ext = 'jpg';
            var basename = src.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
            var scrambledName = basename + '.ws.' + ext;

            images.push({ name: scrambledName, data: result.image });

            /* Build new img tag with data attributes */
            var newTag = fullTag
                .replace(/src\s*=\s*['"][^'"]+['"]/, 'src="' + scrambledName + '"')
                .replace(/<img/, '<img data-ws-scrambled="true" data-ws-tile="' +
                         tileSize + '" data-ws-seed="' + seed +
                         '" data-ws-origw="' + result.width +
                         '" data-ws-origh="' + result.height + '"');

            replacements.push({ from: fullTag, to: newTag });
        } catch(e) {
            warnings.push("Could not scramble image " + src + ": " + (e.message || e));
        }
    }

    /* Apply replacements */
    var out = html;
    for (var i = 0; i < replacements.length; i++) {
        out = out.replace(replacements[i].from, replacements[i].to);
    }

    /* Inject unscramble script before </body> (unless guard handles it) */
    if (images.length > 0 && !skipScript) {
        var bodyClose = out.lastIndexOf('</body>');
        if (bodyClose === -1) bodyClose = out.lastIndexOf('</html>');
        if (bodyClose === -1) bodyClose = out.length;
        out = out.substring(0, bodyClose) + clientUnscrambleScript + '\n' + out.substring(bodyClose);
    }

    return { html: out, images: images, warnings: warnings };
}

module.exports = {
    fontshuffle: fontshuffle,
    scrambleImage: scrambleImage
};
