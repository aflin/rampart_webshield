# rampart-webshield

Font-based text obfuscation and image tile-shuffling for web pages, built
for [Rampart](https://rampart.dev).

Text in the HTML source is replaced with scrambled Unicode characters.  A
matching scrambled font maps those characters back to the correct glyphs, so
the page renders normally in the browser.  Bots and scrapers that read the
raw HTML see only meaningless character sequences.

Images can optionally be tile-shuffled and reassembled client-side via canvas.

A guard mode uses a Chrome DevTools Protocol (CDP) trap to block automation
frameworks (Puppeteer, Playwright, Selenium) from loading the font or
unscrambling images.

## Live Demo

[https://rampart.dev/webshield/](https://rdev.flin.org/webshield/)

## Requirements

- [Rampart](https://rampart.dev) (v0.6.2 or later)
- A C compiler (gcc or cc) for building the font shuffle module
- For image scrambling: `rampart-gm` module and GraphicsMagick libraries
  ```
  # Debian/Ubuntu:
  apt install libgraphicsmagick1-dev
  ```

## Building

```bash
git clone https://github.com/user/rampart-webshield.git
cd rampart-webshield
make
```

This compiles `rampart-fontshuffle.so`, the C module that handles
TrueType/OpenType cmap table parsing, shuffling, and font reassembly.

To build and view the example pages:

```bash
make examples
# Output in examples-output/
```

## Project Structure

```
rampart-fontshuffle.c       # C module: cmap parsing, shuffling, font rebuilding
rampart-fontshuffle.so      # Compiled C module (built by make)
rampart-webshield.js        # JS module: HTML parsing, text remapping, image scrambling, guard
webshield.js                # CLI script
Makefile                    # Build C module and examples
client-scripts-readable.js  # Readable versions of injected client-side JS (reference only)
rampart-fontshuffle-test.js # C module unit tests
examples/                    # Source HTML, fonts, and images for examples
examples-output/            # Generated obfuscated pages (built by make examples)
```

## Quick Start

### CLI

```bash
# Obfuscate a page (multi mode is default):
rampart webshield.js page.html 42 output/

# With image scrambling:
rampart webshield.js page.html 42 output/ --images

# With guard (blocks Puppeteer/Playwright/Selenium):
rampart webshield.js page.html 42 output/ --guard

# All options:
rampart webshield.js page.html 42 output/ --images --guard
```

Output:
- `output/page.html` — obfuscated HTML
- `output/fontname.ws.SEED.ttf` — scrambled font
- `output/imgname.ws.SEED.jpg` — scrambled images (with `--images`)
- `<source_dir>/fontname.ws.SEED-mappings.ws.json` — saved mappings (for `--reuse`)

### Module API

```javascript
var ws = require("rampart-webshield");

var result = ws.fontshuffle("page.html", 42, {
    mode: "multi",
    images: true,
    guard: true
});

// result.text     - obfuscated HTML string
// result.fonts    - [{name: "font.ws.42.ttf", data: Buffer}, ...]
// result.images   - [{name: "img.ws.42.jpg", data: Buffer}, ...]
// result.mappings - mapping data (save as JSON to reuse)
```

## Module API Reference

### ws.fontshuffle(html, seed [, options])

Obfuscates an HTML page by scrambling font cmap tables and remapping text content.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `html` | String | HTML text or a filename to read |
| `seed` | Number | Positive integer for the PRNG seed |
| `options.mode` | String | `"simple"` (default) or `"multi"` |
| `options.mappings` | Object | Previously saved mapping data to reuse |
| `options.images` | Boolean/Object | `true` for default 32px tiles, or `{tileSize: N}` |
| `options.guard` | Boolean/Object | `true` for default 500ms delay, or `{delay: N}` |

**Returns:** `{text, fonts, images, mappings, warnings}`

Font files are discovered automatically from `@font-face` declarations in
inline `<style>` tags and linked stylesheets.  Both local files and remote
URLs (fetched via `rampart-curl`) are supported.

### ws.scrambleImage(image, seed [, options])

Scramble a single image using tile shuffling.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `image` | String/Buffer | Image filename or Buffer |
| `seed` | Number | PRNG seed |
| `options.tileSize` | Number | Tile size in pixels (default: 32) |

**Returns:** `{image: Buffer, width, height, format, tileSize}`

## CLI Reference

```
Usage: rampart webshield.js <input.html> <seed> [output_dir] [options]

  input.html       - Path to the HTML file to obfuscate
  seed             - A positive integer for the PRNG seed
  output_dir       - Output directory (default: ./output)
  --simple         - Use simple mode (1-to-1 substitution)
  --multi          - Use multi mode (default, defeats frequency analysis)
  --reuse          - Reuse existing font + mappings from source directory
  --images         - Scramble <img> tags (tile shuffle, requires rampart-gm)
  --tile-size N    - Tile size in pixels (default: 32)
  --guard          - Enable CDP detection + delayed font loading
  --guard-delay N  - Delay in ms before font loads (default: 500)
```

## Modes

### Simple Mode

Each character maps to exactly one scrambled codepoint.  Fast and
deterministic.  Best for dynamic (per-request) use where the seed changes on
every page load.

### Multi Mode (default for CLI)

Each character maps to many codepoints, all pointing to the same glyph.  The
encoder randomly picks from these aliases, so identical words look different
in the source each time.  This defeats frequency analysis on static pages.

With a font covering ~2000 safe codepoints and a page using ~90 characters,
each character gets ~22 aliases.

## Features

### No-Scramble Zones

Add `data-no-scramble` to any element to prevent its text and images from
being scrambled.  Use this for code blocks or other content that needs to be
copy-pasteable.

```html
<div data-no-scramble="true">
    <pre><code>This text will not be scrambled.</code></pre>
</div>
```

Pair with a system font in CSS so unscrambled text renders correctly:

```css
[data-no-scramble],
[data-no-scramble] code,
[data-no-scramble] pre {
    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
}
```

### Image Scrambling

Images are tile-shuffled using a seeded PRNG.  A client-side canvas script
reassembles the tiles in the browser.  The scrambled image file is served
directly — right-clicking and saving gives you the shuffled version.

Requires the `rampart-gm` module and GraphicsMagick libraries.

### Guard Mode

When enabled, the guard injects a small inline script that:

1. **CDP Proxy trap** — Detects Chrome DevTools Protocol automation
   (Puppeteer, Playwright, Selenium).  The font is never loaded, so
   both page source and rendered output are unreadable.
2. **Delayed font loading** — The font loads after a configurable
   delay (default 500ms), defeating quick screenshot-and-exit bots.
3. **DevTools image protection** — A periodic monitor detects if
   DevTools is opened after page load (using the CDP trap for Chrome,
   `debugger` statement timing for Firefox/Safari) and immediately
   clears any unscrambled canvas images.

All client-side JavaScript is minified and obfuscated in a single line.

### Reusing Fonts Across Pages

Generate the font and mappings from one page, then reuse for others:

```bash
# Generate font + mappings from the first page:
rampart webshield.js page1.html 42 output/

# Reuse for subsequent pages (no font regeneration):
rampart webshield.js page2.html 42 output/ --reuse
rampart webshield.js page3.html 42 output/ --reuse
```

The mappings file is stored alongside the source HTML (not in the public
output directory).  When reusing, if a page contains characters not in the
mappings, a warning is displayed.

In multi mode, the character range is automatically expanded — if any ASCII
character is used, all printable ASCII (0x21–0x7E) is included.  Similarly
for Latin-1 Supplement, Latin Extended, Greek, Cyrillic, Hebrew, and Arabic
ranges.

### Using with rampart-server

```javascript
var server = require("rampart-server");
var ws     = require("rampart-webshield");

// Generate font + mappings once at startup
var init = ws.fontshuffle("template.html", 98765, {
    mode: "multi",
    images: true,
    guard: true
});

// Write font and scrambled images to web root
for (var i = 0; i < init.fonts.length; i++)
    rampart.utils.fprintf("html/" + init.fonts[i].name, '%s', init.fonts[i].data);
for (var i = 0; i < init.images.length; i++)
    rampart.utils.fprintf("html/" + init.images[i].name, '%s', init.images[i].data);

var savedMappings = init.mappings;

server.start({
    bind: ["0.0.0.0:8080"],
    map: {
        "/": function(req) {
            var result = ws.fontshuffle(
                "template.html", 0,
                {mappings: savedMappings}
            );
            return {html: result.text};
        }
    }
});
```

Since multi mode uses `Math.random()` for alias selection, each
response contains different codepoints for the same text.  Scrapers
cannot correlate repeated requests to crack the substitution.

## How It Works

### Font Obfuscation

1. Parses the HTML to find `@font-face` declarations
2. Reads the font file (local or remote via `rampart-curl`)
3. Parses the TrueType/OpenType `cmap` table (Format 4 and Format 12)
4. Shuffles the codepoint-to-glyph mappings using a seeded xorshift64 PRNG
5. Builds a new cmap table (always Format 12 for simplicity)
6. Reassembles the font with updated checksums
7. Rewrites the HTML text content using the new mappings

Characters are shuffled within BiDi-safe groups:
- **LTR letters** (Latin, Greek, Cyrillic, Armenian, Georgian)
  shuffle among themselves
- **RTL characters** (Hebrew, Arabic base characters) shuffle
  among themselves
- **Neutral characters** (symbols, punctuation, digits) shuffle
  among themselves
- **Never shuffled**: combining marks, whitespace, control
  characters, Private Use Area codepoints, Arabic Presentation
  Form ligatures (U+FEF5–U+FEFC), Arabic/Hebrew/Syriac combining
  marks, zero-width characters

Zero-width characters (U+200B–U+200F, e.g.  Zero-Width Non-Joiner used in
Farsi) are converted to HTML entities so browsers handle them natively
regardless of font.

The `<title>` tag, `<script>` blocks, `<style>` blocks, HTML entities, and
`data-no-scramble` zones are left untouched.

**Font requirement**: The page must use web fonts via `@font-face`. 
System/built-in fonts cannot be scrambled.  If no `@font-face` is found, the
module throws a helpful error with an example of how to add one.

### Multi-Font Support

When a page uses multiple fonts, the module builds the mapping from the
first font's codepoint pool, then reuses that mapping for subsequent fonts. 
If a later font covers character groups the first font didn't (e.g., Arabic
characters in a Noto Sans Arabic font when the first font was Inter), a
supplementary mapping is built from the new font's pool without conflicting
with existing aliases.

This means pages can mix fonts freely — e.g., Inter for Latin text, Noto
Sans Arabic for Farsi, bold/italic variants — and all share a consistent
mapping.

### Image Tile Shuffling

1. Divides the image into a grid of tiles (default 32x32 pixels)
2. Fisher-Yates shuffles the tile positions using the seeded PRNG
3. Writes the shuffled image
4. Injects a client-side canvas script that reverses the shuffle

### CDP Guard

The Chrome DevTools Protocol requires calling `Runtime.enable` to control
the browser.  This creates a detectable side effect:

```javascript
var detected = false;
var trap = new Proxy({}, {
    ownKeys: function() { detected = true; return []; }
});
console.groupEnd(Object.create(trap));
// detected === true if CDP is active
```

When `Runtime.enable` is active, Chrome's inspector serializes console
arguments, walking the prototype chain and triggering the Proxy's `ownKeys`
trap.  Normal browsing never triggers this.

For Firefox and Safari, a `debugger` statement timing check detects DevTools
after page load.  When the debugger pauses and the user resumes, the
unscrambled canvas images are immediately cleared before the next frame
renders, preventing the user from copying them.

## Limitations

- **TTF/OTF only** — WOFF/WOFF2 fonts are detected and rejected
  with a clear error
- **Font collections (TTC) not supported**
- **cmap Formats 4 and 12 only** — covers ~99% of fonts in practice
- **`@import` in CSS is not followed**
- **Accessibility** — Screen readers will read scrambled codepoints.
  The `<title>` tag is preserved for browser tabs.
- **Copy/paste** — Users copying text get scrambled characters
  (this is intentional)
- **SEO** — Search engines cannot index the obfuscated text
- **CDP guard is Chrome-specific** — Firefox/Safari DevTools
  protection uses `debugger` timing as a fallback
- **Page must use `@font-face`** — system/built-in fonts cannot
  be scrambled

## Running Tests

```bash
rampart rampart-fontshuffle-test.js
```

## License

MIT
