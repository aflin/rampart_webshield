/*
    webshield.js - CLI for rampart-webshield

    Usage: rampart webshield.js <input.html> <seed> [output_dir] [--simple] [--reuse]

    Default mode is multi. Use --simple for 1-to-1 substitution.
*/

rampart.globalize(rampart.utils);

var ws = require("rampart-webshield");

/* ---- Parse arguments ---- */
var args = process.argv;
var mode = "multi";
var reuse = false;
var useGuard = false;
var guardDelay = 500;
var useEmail = false;
var useImages = false;
var tileSize = 32;
var positional = [];

var showHelp = false;

for (var i = 2; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h' || args[i] === 'help') showHelp = true;
    else if (args[i] === '--simple') mode = "simple";
    else if (args[i] === '--multi') mode = "multi";
    else if (args[i] === '--reuse') reuse = true;
    else if (args[i] === '--guard') useGuard = true;
    else if (args[i] === '--email') useEmail = true;
    else if (args[i] === '--guard-delay' && args[i+1]) guardDelay = parseInt(args[++i]);
    else if (args[i] === '--images') useImages = true;
    else if (args[i] === '--tile-size' && args[i+1]) tileSize = parseInt(args[++i]);
    else positional.push(args[i]);
}

var usageStr =
    "Usage: rampart webshield.js <input.html> <seed> [output_dir] [options]\n\n" +
    "  input.html       - Path to the HTML file to obfuscate\n" +
    "  seed             - A positive integer for the PRNG seed\n" +
    "  output_dir       - Output directory (default: ./output)\n" +
    "  --simple         - Use simple mode (1-to-1 substitution)\n" +
    "  --multi          - Use multi mode (default, defeats frequency analysis)\n" +
    "  --reuse          - Reuse existing font + mappings\n" +
    "  --email          - Obfuscate mailto: and tel: links\n" +
    "  --guard          - Enable CDP detection + delayed font loading\n" +
    "  --guard-delay ms - Delay before font loads (default: 500)\n" +
    "  --images         - Scramble <img> tags (tile shuffle)\n" +
    "  --tile-size px   - Tile size for image scrambling (default: 32)\n" +
    "  help             - Show detailed help\n" +
    "                     (or: rampart webshield.js -- --help)\n";

if (showHelp) {
    printf(
"rampart-webshield - Font-based text obfuscation for web pages\n" +
"=============================================================\n\n" +
"Protects web page content from scraping by scrambling the font's character\n" +
"mapping (cmap table).  Text in the HTML source becomes meaningless Unicode.\n" +
"The browser loads the scrambled font and renders the correct glyphs, so\n" +
"human visitors see the intended text.  Bots reading the raw HTML do not.\n\n" +
"MODES\n" +
"-----\n" +
"  Multi (default):  Each character maps to many codepoints, all pointing\n" +
"                    to the same glyph.  The encoder randomly picks from\n" +
"                    these aliases, so identical words look different in\n" +
"                    the source each time.  Defeats frequency analysis.\n\n" +
"  Simple:           Each character maps to exactly one scrambled codepoint.\n" +
"                    Deterministic and fast.  Best for dynamic per-request\n" +
"                    use where the seed changes on every page load.\n\n" +
"EMAIL PROTECTION (--email)\n" +
"-------------------------\n" +
"  mailto: and tel: links are obfuscated in the HTML source.  The href is\n" +
"  replaced with '#' and the address is XOR-encoded in a data attribute.\n" +
"  A small inline script decodes the address on click.\n\n" +
"IMAGE SCRAMBLING (--images)\n" +
"--------------------------\n" +
"  Images are tile-shuffled using a seeded PRNG.  A client-side canvas\n" +
"  script reassembles the tiles in the browser.  Right-clicking and saving\n" +
"  gives the shuffled version.  Requires the rampart-gm module.\n\n" +
"GUARD MODE (--guard)\n" +
"--------------------\n" +
"  Injects a CDP (Chrome DevTools Protocol) Proxy trap that detects\n" +
"  automation frameworks (Puppeteer, Playwright, Selenium).  When detected:\n" +
"    - The scrambled font is never loaded (text stays garbled)\n" +
"    - Images are not unscrambled\n" +
"    - Email/phone links are not decoded\n" +
"  Also delays font loading (default 500ms) to defeat quick-screenshot bots.\n" +
"  A periodic monitor uses the CDP trap and debugger timing to detect\n" +
"  DevTools opened after page load, clearing unscrambled canvas images.\n" +
"  Implies --email.\n\n" +
"REUSE (--reuse)\n" +
"---------------\n" +
"  Reuse existing font files and mappings from a previous run.  Mappings\n" +
"  are stored alongside the source HTML as <fontname>.ws.<seed>-mappings.ws.json.\n" +
"  The scrambled font file must exist in the output directory.\n" +
"  Useful for encoding multiple pages with the same font.\n\n" +
"NO-SCRAMBLE AND SCRAMBLE ZONES\n" +
"-------------------------------\n" +
"  Add data-no-scramble to any HTML element to prevent its text and images\n" +
"  from being scrambled.  Use for code blocks or copy-pasteable content.\n" +
"  Pair with a system font in CSS for those elements.\n\n" +
"  Add data-scramble to re-enable scrambling inside a data-no-scramble zone.\n" +
"  Example: put data-no-scramble on <body> to keep the whole page readable, then\n" +
"  add data-scramble to specific elements like email links that need\n" +
"  obfuscation.  The scrambled elements use the scrambled font; everything\n" +
"  else uses the original fonts from the page's stylesheet.\n\n" +
"MULTIPLE FONTS\n" +
"--------------\n" +
"  Pages with multiple @font-face declarations are supported.  Each font\n" +
"  is scrambled independently but shares a consistent mapping.  Works with\n" +
"  bold/italic variants, mixed LTR/RTL scripts, and overlapping codepoints.\n" +
"  Font files include the seed in their name to prevent collisions.\n\n" +
"FONT DISCOVERY\n" +
"--------------\n" +
"  The page must use web fonts via @font-face.  System/built-in fonts\n" +
"  cannot be scrambled.  Fonts are discovered from three sources:\n" +
"    - Inline @font-face in <style> blocks\n" +
"    - <link rel='stylesheet'> (fetched locally or via rampart-curl)\n" +
"    - @import url(...) in <style> blocks (fetched and parsed)\n" +
"  JavaScript-loaded fonts are not supported.\n\n" +
"MODULE API\n" +
"----------\n" +
"  var ws = require('rampart-webshield');\n" +
"  var result = ws.fontshuffle(html, seed, {mode, email, images, guard, mappings});\n" +
"  // result.text     - obfuscated HTML\n" +
"  // result.fonts    - [{name, data}, ...]\n" +
"  // result.images   - [{name, data}, ...]\n" +
"  // result.mappings - save as JSON for --reuse\n\n"
    );
    printf("%s", usageStr);
    process.exit(0);
}

if (positional.length < 2) {
    fprintf(stderr, "%s", usageStr);
    process.exit(1);
}

var inputHtmlPath = positional[0];
var seed = parseInt(positional[1]);
var outputDir = positional[2] || (process.scriptPath + "/output");

if (isNaN(seed) || seed < 1) {
    fprintf(stderr, "Error: seed must be a positive integer\n");
    process.exit(1);
}

if (!stat(outputDir))
    mkdir(outputDir);

var inputDir = inputHtmlPath.replace(/\/[^\/]*$/, '');
if (inputDir === inputHtmlPath) inputDir = '.';

/* ---- Load existing mappings if --reuse ---- */
var options = { mode: mode };

if (reuse) {
    /* Find *-mappings.ws.json files alongside the source */
    var sourceFiles = readDir(inputDir);
    var mappings = {};
    var found = false;
    for (var i = 0; i < sourceFiles.length; i++) {
        if (/-mappings\.ws\.json$/.test(sourceFiles[i])) {
            var jsonText = readFile(inputDir + '/' + sourceFiles[i], true);
            if (jsonText) {
                var saved = JSON.parse(jsonText);
                for (var url in saved) {
                    if (saved.hasOwnProperty(url)) {
                        mappings[url] = saved[url];
                        found = true;
                    }
                }
            }
        }
    }
    if (found) {
        /* Verify the scrambled font files exist in the output directory */
        for (var url in mappings) {
            if (mappings.hasOwnProperty(url) && mappings[url].fontFile) {
                var fontPath = outputDir + '/' + mappings[url].fontFile;
                if (!stat(fontPath)) {
                    fprintf(stderr, "Error: scrambled font file not found: %s\n", fontPath);
                    fprintf(stderr, "  Expected by mappings for: %s\n", url);
                    fprintf(stderr, "  Run without --reuse to regenerate.\n");
                    process.exit(1);
                }
            }
        }
        options.mappings = mappings;
        printf("Reusing existing mappings from %s/\n", inputDir);
    } else {
        fprintf(stderr, "Error: --reuse specified but no mappings found in %s/\n", inputDir);
        fprintf(stderr, "  Run without --reuse first to generate font and mappings.\n");
        process.exit(1);
    }
}

/* ---- Email/guard options ---- */
if (useGuard) {
    options.guard = { delay: guardDelay };
    printf("Guard enabled (CDP trap + %dms delay)\n", guardDelay);
}
if (useEmail || useGuard) {
    options.email = true;
}

/* ---- Image options ---- */
if (useImages) {
    options.images = { tileSize: tileSize };
    printf("Image scrambling enabled (tile size: %d)\n", tileSize);
}

/* ---- Run fontshuffle ---- */
printf("Processing: %s (mode: %s)\n", inputHtmlPath, mode);

var result = ws.fontshuffle(inputHtmlPath, seed, options);

/* Print warnings */
if (result.warnings && result.warnings.length > 0) {
    for (var i = 0; i < result.warnings.length; i++)
        fprintf(stderr, "Warning: %s\n", result.warnings[i]);
}

/* Write font files to output dir */
for (var i = 0; i < result.fonts.length; i++) {
    var f = result.fonts[i];
    fprintf(outputDir + '/' + f.name, '%s', f.data);
    printf("  Font: %s/%s (%d bytes)\n", outputDir, f.name, f.data.length);
}

/* Write scrambled image files to output dir */
if (result.images) {
    for (var i = 0; i < result.images.length; i++) {
        var img = result.images[i];
        fprintf(outputDir + '/' + img.name, '%s', img.data);
        printf("  Image: %s/%s (%d bytes)\n", outputDir, img.name, img.data.length);
    }
}

/* Write mappings alongside the source HTML (not in the public output dir) */
for (var url in result.mappings) {
    if (result.mappings.hasOwnProperty(url)) {
        var fontFile = result.mappings[url].fontFile;
        var mapBasename = fontFile.replace(/\.ws\.[^.]+$/, '') + '-mappings.ws.json';
        var mapObj = {};
        mapObj[url] = result.mappings[url];
        fprintf(inputDir + '/' + mapBasename, '%s', JSON.stringify(mapObj, null, 2));
        printf("  Mappings: %s/%s\n", inputDir, mapBasename);
    }
}

/* Write HTML to output dir (preserve original filename) */
var htmlBasename = inputHtmlPath.replace(/^.*\//, '');
var outputHtmlPath = outputDir + '/' + htmlBasename;
fprintf(outputHtmlPath, '%s', result.text);
printf("  HTML: %s\n", outputHtmlPath);

printf("\nDone! Output in %s/\n", outputDir.replace(/\/+$/, ''));
