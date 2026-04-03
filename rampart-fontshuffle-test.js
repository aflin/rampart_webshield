
rampart.globalize(rampart.utils);

var webshield = require("rampart-fontshuffle");

var testFontPath = "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf";

function testFeature(name, test, error)
{
    if (typeof test == 'function') {
        try {
            test = test();
        } catch(e) {
            error = e;
            test = false;
        }
    }
    printf("testing %-56s - ", name);
    if (test)
        printf("passed\n");
    else
    {
        printf(">>>>> FAILED <<<<<\n");
        if (error) printf('%J\n', error);
        process.exit(1);
    }
    if (error) console.log(error);
}

/* ---- Load test font ---- */
var fontBuf = readFile(testFontPath);
if (!fontBuf || !fontBuf.length) {
    fprintf(stderr, "Could not read test font: %s\n", testFontPath);
    process.exit(1);
}
printf("Loaded test font: %s (%d bytes)\n\n", testFontPath, fontBuf.length);

/* ---- Test 1: obfuscateFont returns correct structure ---- */
testFeature("obfuscateFont returns an object", function() {
    var result = webshield.obfuscateFont(fontBuf, 42);
    return typeof result === 'object' && result !== null;
});

testFeature("result has 'font' property (Buffer)", function() {
    var result = webshield.obfuscateFont(fontBuf, 42);
    return result.font && result.font.length > 0;
});

testFeature("result has 'mapping' property (Object)", function() {
    var result = webshield.obfuscateFont(fontBuf, 42);
    return typeof result.mapping === 'object' && result.mapping !== null;
});

/* ---- Test 2: mapping has entries ---- */
testFeature("mapping has entries", function() {
    var result = webshield.obfuscateFont(fontBuf, 42);
    return Object.keys(result.mapping).length > 0;
});

/* ---- Test 3: mapping is a bijection (no duplicate values) ---- */
testFeature("mapping is a bijection (no duplicate new codepoints)", function() {
    var result = webshield.obfuscateFont(fontBuf, 42);
    var m = result.mapping;
    var keys = Object.keys(m);
    var vals = {};
    for (var i = 0; i < keys.length; i++) {
        var v = m[keys[i]];
        if (vals[v]) return false;
        vals[v] = true;
    }
    return true;
});

/* ---- Test 4: same seed produces same mapping ---- */
testFeature("same seed produces same mapping", function() {
    var r1 = webshield.obfuscateFont(fontBuf, 12345);
    var r2 = webshield.obfuscateFont(fontBuf, 12345);
    var k1 = Object.keys(r1.mapping);
    var k2 = Object.keys(r2.mapping);
    if (k1.length !== k2.length) return false;
    for (var i = 0; i < k1.length; i++) {
        if (r1.mapping[k1[i]] !== r2.mapping[k1[i]]) return false;
    }
    return true;
});

/* ---- Test 5: different seed produces different mapping ---- */
testFeature("different seed produces different mapping", function() {
    var r1 = webshield.obfuscateFont(fontBuf, 42);
    var r2 = webshield.obfuscateFont(fontBuf, 99);
    var keys = Object.keys(r1.mapping);
    var diffCount = 0;
    for (var i = 0; i < keys.length; i++) {
        if (r1.mapping[keys[i]] !== r2.mapping[keys[i]])
            diffCount++;
    }
    /* Most should differ */
    return diffCount > keys.length / 2;
});

/* ---- Test 6: mapping values are all valid codepoint numbers ---- */
testFeature("mapping values are valid codepoint numbers", function() {
    var result = webshield.obfuscateFont(fontBuf, 42);
    var keys = Object.keys(result.mapping);
    for (var i = 0; i < keys.length; i++) {
        var v = result.mapping[keys[i]];
        if (typeof v !== 'number' || v < 0 || v > 0x10FFFF) return false;
    }
    return true;
});

/* ---- Test 7: output font starts with valid magic ---- */
testFeature("output font has valid TrueType/OTF header", function() {
    var result = webshield.obfuscateFont(fontBuf, 42);
    var f = result.font;
    if (f.length < 12) return false;
    /* Check for TrueType magic 00 01 00 00 */
    var magic = (f[0] << 24) | (f[1] << 16) | (f[2] << 8) | f[3];
    return magic === 0x00010000 || magic === 0x4F54544F;
});

/* ---- Test 8: output font preserves table count ---- */
testFeature("output font preserves number of tables", function() {
    var result = webshield.obfuscateFont(fontBuf, 42);
    var origTables = (fontBuf[4] << 8) | fontBuf[5];
    var newTables  = (result.font[4] << 8) | result.font[5];
    return origTables === newTables;
});

/* ---- Test 9: round-trip mapping ---- */
testFeature("round-trip: mapping + inverse recovers original", function() {
    var result = webshield.obfuscateFont(fontBuf, 42);
    var m = result.mapping;
    var keys = Object.keys(m);

    /* Build inverse mapping */
    var inv = {};
    for (var i = 0; i < keys.length; i++) {
        inv[m[keys[i]]] = parseInt(keys[i]);
    }

    /* Test with ASCII 'A' (codepoint 65) */
    var orig = 65;
    var scrambled = m["65"];
    if (scrambled === undefined) return false;
    var recovered = inv[scrambled];
    return recovered === orig;
});

/* ---- Test 10: error handling ---- */
testFeature("throws on non-buffer first argument", function() {
    try {
        webshield.obfuscateFont("not a buffer", 42);
        return false;
    } catch(e) {
        return true;
    }
});

testFeature("throws on non-number second argument", function() {
    try {
        webshield.obfuscateFont(fontBuf, "not a number");
        return false;
    } catch(e) {
        return true;
    }
});

testFeature("throws on truncated font", function() {
    try {
        webshield.obfuscateFont(stringToBuffer("tiny"), 42);
        return false;
    } catch(e) {
        return true;
    }
});

printf("\nAll tests passed!\n");
