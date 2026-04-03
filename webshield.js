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
var useImages = false;
var tileSize = 32;
var positional = [];

for (var i = 2; i < args.length; i++) {
    if (args[i] === '--simple') mode = "simple";
    else if (args[i] === '--multi') mode = "multi";
    else if (args[i] === '--reuse') reuse = true;
    else if (args[i] === '--guard') useGuard = true;
    else if (args[i] === '--guard-delay' && args[i+1]) guardDelay = parseInt(args[++i]);
    else if (args[i] === '--images') useImages = true;
    else if (args[i] === '--tile-size' && args[i+1]) tileSize = parseInt(args[++i]);
    else positional.push(args[i]);
}

if (positional.length < 2) {
    fprintf(stderr,
        "Usage: rampart webshield.js <input.html> <seed> [output_dir] [options]\n\n" +
        "  input.html       - Path to the HTML file to obfuscate\n" +
        "  seed             - A positive integer for the PRNG seed\n" +
        "  output_dir       - Output directory (default: ./output)\n" +
        "  --simple         - Use simple mode (1-to-1 substitution)\n" +
        "  --multi          - Use multi mode (default, defeats frequency analysis)\n" +
        "  --reuse          - Reuse existing font + mappings\n" +
        "  --guard          - Enable CDP detection + delayed font loading\n" +
        "  --guard-delay ms - Delay before font loads (default: 500)\n" +
        "  --images         - Scramble <img> tags (tile shuffle)\n" +
        "  --tile-size px   - Tile size for image scrambling (default: 32)\n"
    );
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

/* ---- Guard options ---- */
if (useGuard) {
    options.guard = { delay: guardDelay };
    printf("Guard enabled (CDP trap + %dms delay)\n", guardDelay);
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

printf("\nDone! Output in %s/\n", outputDir);
