/*
    rampart-fontshuffle.c - Font obfuscation for anti-scraping

    Reads a TrueType/OpenType font buffer, scrambles the cmap table
    using a seeded PRNG, and returns the new font + a codepoint mapping.

    MIT License
*/

#define _DEFAULT_SOURCE
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
#include "/usr/local/rampart/include/rampart.h"

/* ============================================================
   Big-endian read/write helpers (TrueType is big-endian)
   ============================================================ */

#define RD16(p) ((uint16_t)( \
    (((const uint8_t*)(p))[0] << 8) | \
     ((const uint8_t*)(p))[1] ))

#define RD32(p) ((uint32_t)( \
    (((const uint8_t*)(p))[0] << 24) | \
    (((const uint8_t*)(p))[1] << 16) | \
    (((const uint8_t*)(p))[2] <<  8) | \
     ((const uint8_t*)(p))[3] ))

#define WR16(p,v) do { \
    ((uint8_t*)(p))[0] = (uint8_t)((v) >> 8); \
    ((uint8_t*)(p))[1] = (uint8_t)(v); \
} while(0)

#define WR32(p,v) do { \
    ((uint8_t*)(p))[0] = (uint8_t)((v) >> 24); \
    ((uint8_t*)(p))[1] = (uint8_t)((v) >> 16); \
    ((uint8_t*)(p))[2] = (uint8_t)((v) >>  8); \
    ((uint8_t*)(p))[3] = (uint8_t)(v); \
} while(0)

/* ============================================================
   Seeded PRNG (xorshift64)
   Based on fast_random.c by P B Richards (public domain)
   ============================================================ */

#define XORRAND64_DEFAULT_SEED 0xFEE1BADCEEDBA11ULL

static uint64_t xorRand64(uint64_t *state)
{
    uint64_t x = *state;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    *state = x;
    return x;
}

/* ============================================================
   TrueType table checksum
   ============================================================ */

static uint32_t calc_checksum(const uint8_t *data, uint32_t length)
{
    uint32_t sum = 0;
    uint32_t nwords = (length + 3) / 4;
    for (uint32_t i = 0; i < nwords; i++) {
        uint32_t off = i * 4;
        uint32_t word = 0;
        for (int j = 0; j < 4; j++) {
            word <<= 8;
            if (off + j < length)
                word |= data[off + j];
        }
        sum += word;
    }
    return sum;
}

/* ============================================================
   cmap entry: one codepoint → glyphID mapping
   ============================================================ */

typedef struct {
    uint32_t codepoint;
    uint32_t glyphID;
} CmapEntry;

/* Dynamic array helpers */
typedef struct {
    CmapEntry *items;
    int count;
    int capacity;
} CmapEntryArray;

static void cmap_array_init(CmapEntryArray *a)
{
    a->items = NULL;
    a->count = 0;
    a->capacity = 0;
}

static void cmap_array_push(CmapEntryArray *a, uint32_t codepoint, uint32_t glyphID)
{
    if (a->count >= a->capacity) {
        a->capacity = a->capacity ? a->capacity * 2 : 256;
        a->items = realloc(a->items, a->capacity * sizeof(CmapEntry));
    }
    a->items[a->count].codepoint = codepoint;
    a->items[a->count].glyphID   = glyphID;
    a->count++;
}

static void cmap_array_free(CmapEntryArray *a)
{
    free(a->items);
    a->items = NULL;
    a->count = 0;
    a->capacity = 0;
}

/* ============================================================
   Parse cmap Format 4 (BMP, segmented)
   ============================================================ */

static int parse_cmap_format4(const uint8_t *sub, uint32_t sub_len, CmapEntryArray *out)
{
    if (sub_len < 14) return -1;

    uint16_t segCountX2 = RD16(sub + 6);
    uint16_t segCount = segCountX2 / 2;

    /* Minimum size check: header(14) + endCode(segCount*2) + pad(2) +
       startCode(segCount*2) + idDelta(segCount*2) + idRangeOffset(segCount*2) */
    uint32_t min_len = 14 + (uint32_t)segCount * 8 + 2;
    if (sub_len < min_len) return -1;

    const uint8_t *endCodes      = sub + 14;
    /* 2 bytes reserved padding after endCodes */
    const uint8_t *startCodes    = endCodes + segCountX2 + 2;
    const uint8_t *idDeltas      = startCodes + segCountX2;
    const uint8_t *idRangeOffs   = idDeltas + segCountX2;

    for (uint16_t seg = 0; seg < segCount; seg++) {
        uint16_t endCode      = RD16(endCodes    + seg * 2);
        uint16_t startCode    = RD16(startCodes  + seg * 2);
        int16_t  idDelta      = (int16_t)RD16(idDeltas + seg * 2);
        uint16_t idRangeOff   = RD16(idRangeOffs + seg * 2);

        if (startCode == 0xFFFF) break; /* sentinel segment */

        for (uint32_t cp = startCode; cp <= endCode; cp++) {
            uint16_t glyphID;
            if (idRangeOff == 0) {
                glyphID = (uint16_t)((cp + idDelta) & 0xFFFF);
            } else {
                /* offset into glyphIdArray:
                   &idRangeOffset[seg] + idRangeOff + (cp - startCode) * 2 */
                const uint8_t *ptr = idRangeOffs + seg * 2 + idRangeOff + (cp - startCode) * 2;
                if (ptr + 2 > sub + sub_len) continue;
                glyphID = RD16(ptr);
                if (glyphID != 0)
                    glyphID = (uint16_t)((glyphID + idDelta) & 0xFFFF);
            }
            if (glyphID != 0)
                cmap_array_push(out, cp, glyphID);
        }
    }
    return 0;
}

/* ============================================================
   Parse cmap Format 12 (full Unicode, segmented coverage)
   ============================================================ */

static int parse_cmap_format12(const uint8_t *sub, uint32_t sub_len, CmapEntryArray *out)
{
    if (sub_len < 16) return -1;

    uint32_t numGroups = RD32(sub + 12);
    if (sub_len < 16 + numGroups * 12) return -1;

    const uint8_t *groups = sub + 16;
    for (uint32_t g = 0; g < numGroups; g++) {
        uint32_t startChar  = RD32(groups + g * 12);
        uint32_t endChar    = RD32(groups + g * 12 + 4);
        uint32_t startGlyph = RD32(groups + g * 12 + 8);

        for (uint32_t cp = startChar; cp <= endChar; cp++) {
            uint32_t glyphID = startGlyph + (cp - startChar);
            if (glyphID != 0)
                cmap_array_push(out, cp, glyphID);
        }
    }
    return 0;
}

/* ============================================================
   Find and parse the cmap table from a font
   ============================================================ */

static int find_and_parse_cmap(const uint8_t *font, size_t fontlen,
                               CmapEntryArray *out,
                               uint32_t *cmap_table_offset_out,
                               uint32_t *cmap_table_length_out,
                               int *cmap_table_index_out)
{
    if (fontlen < 12) return -1;

    uint16_t numTables = RD16(font + 4);
    if (fontlen < 12 + (uint32_t)numTables * 16) return -1;

    /* Find the cmap table record */
    uint32_t cmap_offset = 0, cmap_length = 0;
    int cmap_idx = -1;
    for (uint16_t i = 0; i < numTables; i++) {
        const uint8_t *rec = font + 12 + i * 16;
        if (rec[0]=='c' && rec[1]=='m' && rec[2]=='a' && rec[3]=='p') {
            cmap_offset = RD32(rec + 8);
            cmap_length = RD32(rec + 12);
            cmap_idx = i;
            break;
        }
    }
    if (cmap_idx < 0) return -1;
    if (cmap_offset + cmap_length > fontlen) return -1;

    *cmap_table_offset_out = cmap_offset;
    *cmap_table_length_out = cmap_length;
    *cmap_table_index_out  = cmap_idx;

    const uint8_t *cmap = font + cmap_offset;
    if (cmap_length < 4) return -1;

    uint16_t numSubtables = RD16(cmap + 2);
    if (cmap_length < 4 + (uint32_t)numSubtables * 8) return -1;

    /* Find the best encoding subtable:
       Priority: platformID=3 encodingID=10 (Win full Unicode, Format 12)
                 platformID=3 encodingID=1  (Win BMP, Format 4)
                 platformID=0 (Unicode, any encoding)                     */
    int best_score = -1;
    uint32_t best_sub_offset = 0;
    for (uint16_t i = 0; i < numSubtables; i++) {
        const uint8_t *erec = cmap + 4 + i * 8;
        uint16_t platID = RD16(erec);
        uint16_t encID  = RD16(erec + 2);
        uint32_t suboff = RD32(erec + 4);
        int score = -1;

        if (platID == 3 && encID == 10) score = 3;      /* best: Win full Unicode */
        else if (platID == 3 && encID == 1)  score = 2;  /* Win BMP */
        else if (platID == 0)                score = 1;  /* Unicode platform */

        if (score > best_score) {
            best_score = score;
            best_sub_offset = suboff;
        }
    }
    if (best_score < 0) return -1;

    if (best_sub_offset + 2 > cmap_length) return -1;
    const uint8_t *sub = cmap + best_sub_offset;
    uint32_t sub_avail = cmap_length - best_sub_offset;
    uint16_t format = RD16(sub);

    if (format == 4)
        return parse_cmap_format4(sub, sub_avail, out);
    else if (format == 12)
        return parse_cmap_format12(sub, sub_avail, out);

    return -1; /* unsupported format */
}

/* ============================================================
   Classify codepoints for shuffle grouping.
   Returns:
     0 = do not shuffle (combining, control, whitespace, format)
     1 = LTR (left-to-right scripts)
     2 = RTL (right-to-left scripts)
   Characters are only shuffled within their own group.
   ============================================================ */

#define CP_GROUP_NONE    0  /* don't shuffle: combining, control, whitespace */
#define CP_GROUP_LTR     1  /* strong LTR: letters from LTR scripts */
#define CP_GROUP_RTL     2  /* strong RTL: Hebrew, Arabic, etc. */
#define CP_GROUP_NEUTRAL 3  /* BiDi-neutral: symbols, punctuation, numbers */
#define CP_NUM_GROUPS    4

static int classify_codepoint(uint32_t cp)
{
    /* ---- Group 0: never shuffle ---- */

    /* ASCII/Latin-1 control characters and whitespace */
    if (cp <= 0x20) return CP_GROUP_NONE;  /* controls + space */
    if (cp >= 0x7F && cp <= 0x9F) return CP_GROUP_NONE;
    if (cp == 0xA0) return CP_GROUP_NONE;  /* no-break space */
    if (cp == 0xAD) return CP_GROUP_NONE;  /* soft hyphen */

    /* Unicode whitespace and separators */
    if (cp == 0x1680) return CP_GROUP_NONE;
    if (cp >= 0x2000 && cp <= 0x200A) return CP_GROUP_NONE;
    if (cp == 0x205F) return CP_GROUP_NONE;
    if (cp == 0x3000) return CP_GROUP_NONE;

    /* Combining Diacritical Marks */
    if (cp >= 0x0300 && cp <= 0x036F) return CP_GROUP_NONE;
    if (cp >= 0x0483 && cp <= 0x0489) return CP_GROUP_NONE;
    /* Devanagari/Indic combining */
    if (cp >= 0x0900 && cp <= 0x0903) return CP_GROUP_NONE;
    if (cp >= 0x093A && cp <= 0x094F) return CP_GROUP_NONE;
    if (cp >= 0x0951 && cp <= 0x0957) return CP_GROUP_NONE;
    if (cp >= 0x0962 && cp <= 0x0963) return CP_GROUP_NONE;
    if (cp >= 0x0981 && cp <= 0x0983) return CP_GROUP_NONE;
    if (cp >= 0x09BC && cp <= 0x09CD) return CP_GROUP_NONE;
    if (cp >= 0x0A01 && cp <= 0x0A03) return CP_GROUP_NONE;
    if (cp >= 0x0A3C && cp <= 0x0A4D) return CP_GROUP_NONE;
    if (cp >= 0x0A81 && cp <= 0x0A83) return CP_GROUP_NONE;
    if (cp >= 0x0ABC && cp <= 0x0ACD) return CP_GROUP_NONE;
    if (cp >= 0x0B01 && cp <= 0x0B03) return CP_GROUP_NONE;
    if (cp >= 0x0B3C && cp <= 0x0B4D) return CP_GROUP_NONE;
    if (cp >= 0x0B82 && cp <= 0x0B83) return CP_GROUP_NONE;
    if (cp >= 0x0BBE && cp <= 0x0BCD) return CP_GROUP_NONE;
    if (cp >= 0x0C01 && cp <= 0x0C03) return CP_GROUP_NONE;
    if (cp >= 0x0C3E && cp <= 0x0C4D) return CP_GROUP_NONE;
    if (cp >= 0x0C81 && cp <= 0x0C83) return CP_GROUP_NONE;
    if (cp >= 0x0CBE && cp <= 0x0CCD) return CP_GROUP_NONE;
    if (cp >= 0x0D02 && cp <= 0x0D03) return CP_GROUP_NONE;
    if (cp >= 0x0D3E && cp <= 0x0D4D) return CP_GROUP_NONE;
    /* Thai combining */
    if (cp == 0x0E31) return CP_GROUP_NONE;
    if (cp >= 0x0E34 && cp <= 0x0E3A) return CP_GROUP_NONE;
    if (cp >= 0x0E47 && cp <= 0x0E4E) return CP_GROUP_NONE;
    /* Lao combining */
    if (cp == 0x0EB1) return CP_GROUP_NONE;
    if (cp >= 0x0EB4 && cp <= 0x0EB9) return CP_GROUP_NONE;
    if (cp >= 0x0EBB && cp <= 0x0EBC) return CP_GROUP_NONE;
    if (cp >= 0x0EC8 && cp <= 0x0ECD) return CP_GROUP_NONE;
    /* Combining Diacritical Marks Extended & Supplement */
    if (cp >= 0x1AB0 && cp <= 0x1AFF) return CP_GROUP_NONE;
    if (cp >= 0x1DC0 && cp <= 0x1DFF) return CP_GROUP_NONE;
    /* Greek Extended combining */
    if (cp >= 0x1FBD && cp <= 0x1FC1) return CP_GROUP_NONE;
    if (cp >= 0x1FCD && cp <= 0x1FCF) return CP_GROUP_NONE;
    if (cp >= 0x1FDD && cp <= 0x1FDF) return CP_GROUP_NONE;
    if (cp >= 0x1FED && cp <= 0x1FEF) return CP_GROUP_NONE;
    if (cp >= 0x1FFD && cp <= 0x1FFE) return CP_GROUP_NONE;
    /* Zero-width and format characters */
    if (cp >= 0x200B && cp <= 0x200F) return CP_GROUP_NONE;
    if (cp >= 0x2028 && cp <= 0x202F) return CP_GROUP_NONE;
    if (cp >= 0x2060 && cp <= 0x206F) return CP_GROUP_NONE;
    /* Combining Diacritical Marks for Symbols */
    if (cp >= 0x20D0 && cp <= 0x20FF) return CP_GROUP_NONE;
    /* Variation selectors, combining half marks */
    if (cp >= 0xFE00 && cp <= 0xFE0F) return CP_GROUP_NONE;
    if (cp >= 0xFE20 && cp <= 0xFE2F) return CP_GROUP_NONE;
    if (cp == 0xFEFF) return CP_GROUP_NONE;
    if (cp >= 0xFFF9 && cp <= 0xFFFB) return CP_GROUP_NONE;
    /* Hebrew combining (within RTL range, must check before RTL) */
    if (cp >= 0x0591 && cp <= 0x05BD) return CP_GROUP_NONE;
    if (cp == 0x05BF) return CP_GROUP_NONE;
    if (cp >= 0x05C1 && cp <= 0x05C2) return CP_GROUP_NONE;
    if (cp >= 0x05C4 && cp <= 0x05C5) return CP_GROUP_NONE;
    if (cp == 0x05C7) return CP_GROUP_NONE;
    /* Arabic combining (within RTL range, must check before RTL) */
    if (cp >= 0x0610 && cp <= 0x061A) return CP_GROUP_NONE;
    if (cp >= 0x064B && cp <= 0x065F) return CP_GROUP_NONE;
    if (cp == 0x0670) return CP_GROUP_NONE;
    if (cp >= 0x06D6 && cp <= 0x06DC) return CP_GROUP_NONE;
    if (cp >= 0x06DF && cp <= 0x06E4) return CP_GROUP_NONE;
    if (cp >= 0x06E7 && cp <= 0x06E8) return CP_GROUP_NONE;
    if (cp >= 0x06EA && cp <= 0x06ED) return CP_GROUP_NONE;
    /* Syriac combining */
    if (cp == 0x0711) return CP_GROUP_NONE;
    if (cp >= 0x0730 && cp <= 0x074A) return CP_GROUP_NONE;
    /* Thaana combining */
    if (cp >= 0x07A6 && cp <= 0x07B0) return CP_GROUP_NONE;
    /* Private Use Areas - unreliable across browsers */
    if (cp >= 0xE000 && cp <= 0xF8FF) return CP_GROUP_NONE;
    if (cp >= 0xF0000 && cp <= 0xFFFFD) return CP_GROUP_NONE;
    if (cp >= 0x100000 && cp <= 0x10FFFD) return CP_GROUP_NONE;
    /* Surrogates and noncharacters */
    if (cp >= 0xD800 && cp <= 0xDFFF) return CP_GROUP_NONE;
    if (cp >= 0xFDD0 && cp <= 0xFDEF) return CP_GROUP_NONE;
    if ((cp & 0xFFFE) == 0xFFFE) return CP_GROUP_NONE;

    /* ---- Group 2: RTL scripts ---- */

    /* Hebrew (base characters only; combining already filtered above) */
    if (cp >= 0x0590 && cp <= 0x05FF) return CP_GROUP_RTL;
    /* Arabic (base characters only) */
    if (cp >= 0x0600 && cp <= 0x06FF) return CP_GROUP_RTL;
    /* Syriac */
    if (cp >= 0x0700 && cp <= 0x074F) return CP_GROUP_RTL;
    /* Arabic Supplement */
    if (cp >= 0x0750 && cp <= 0x077F) return CP_GROUP_RTL;
    /* Thaana */
    if (cp >= 0x0780 && cp <= 0x07BF) return CP_GROUP_RTL;
    /* NKo */
    if (cp >= 0x07C0 && cp <= 0x07FF) return CP_GROUP_RTL;
    /* Samaritan + Mandaic */
    if (cp >= 0x0800 && cp <= 0x085F) return CP_GROUP_RTL;
    /* Syriac Supplement */
    if (cp >= 0x0860 && cp <= 0x086F) return CP_GROUP_RTL;
    /* Arabic Extended-A (base characters only, exclude combining U+08D3+) */
    if (cp >= 0x08A0 && cp <= 0x08D2) return CP_GROUP_RTL;
    if (cp >= 0x08D3 && cp <= 0x08FF) return CP_GROUP_NONE;
    /* Hebrew Presentation Forms */
    if (cp >= 0xFB1D && cp <= 0xFB4F) return CP_GROUP_RTL;
    /* Arabic Presentation Forms-A */
    if (cp >= 0xFB50 && cp <= 0xFDFF) return CP_GROUP_RTL;
    /* Arabic Presentation Forms-B: ligature forms that browsers
       may shape specially — exclude specific ligature ranges */
    if (cp >= 0xFEF5 && cp <= 0xFEFC) return CP_GROUP_NONE; /* Lam-Alef ligatures */
    if (cp >= 0xFE70 && cp <= 0xFEF4) return CP_GROUP_RTL;  /* rest of Forms-B */
    /* Ancient RTL scripts */
    if (cp >= 0x10800 && cp <= 0x10FFF) return CP_GROUP_RTL;

    /* ---- Group 1 vs 3: strong LTR letters vs neutral ---- */

    /* Basic Latin letters */
    if (cp >= 0x41 && cp <= 0x5A) return CP_GROUP_LTR;   /* A-Z */
    if (cp >= 0x61 && cp <= 0x7A) return CP_GROUP_LTR;   /* a-z */
    /* Latin-1 Supplement letters (skip multiply/divide signs) */
    if (cp >= 0xC0 && cp <= 0xD6) return CP_GROUP_LTR;
    if (cp >= 0xD8 && cp <= 0xF6) return CP_GROUP_LTR;
    if (cp >= 0xF8 && cp <= 0xFF) return CP_GROUP_LTR;
    /* Latin Extended-A, B */
    if (cp >= 0x0100 && cp <= 0x024F) return CP_GROUP_LTR;
    /* IPA Extensions */
    if (cp >= 0x0250 && cp <= 0x02AF) return CP_GROUP_LTR;
    /* Spacing Modifier Letters */
    if (cp >= 0x02B0 && cp <= 0x02FF) return CP_GROUP_LTR;
    /* Greek and Coptic (letters only, skip symbols) */
    if (cp >= 0x0370 && cp <= 0x0377) return CP_GROUP_LTR;
    if (cp >= 0x037A && cp <= 0x037F) return CP_GROUP_LTR;
    if (cp >= 0x0384 && cp <= 0x038A) return CP_GROUP_LTR;
    if (cp == 0x038C) return CP_GROUP_LTR;
    if (cp >= 0x038E && cp <= 0x03A1) return CP_GROUP_LTR;
    if (cp >= 0x03A3 && cp <= 0x03FF) return CP_GROUP_LTR;
    /* Cyrillic */
    if (cp >= 0x0400 && cp <= 0x0482) return CP_GROUP_LTR;
    if (cp >= 0x048A && cp <= 0x04FF) return CP_GROUP_LTR;
    /* Cyrillic Supplement */
    if (cp >= 0x0500 && cp <= 0x052F) return CP_GROUP_LTR;
    /* Armenian */
    if (cp >= 0x0531 && cp <= 0x058A) return CP_GROUP_LTR;
    /* Georgian */
    if (cp >= 0x10A0 && cp <= 0x10FF) return CP_GROUP_LTR;
    /* Latin Extended Additional */
    if (cp >= 0x1E00 && cp <= 0x1EFF) return CP_GROUP_LTR;
    /* Greek Extended */
    if (cp >= 0x1F00 && cp <= 0x1FBC) return CP_GROUP_LTR;
    if (cp >= 0x1FC2 && cp <= 0x1FCC) return CP_GROUP_LTR;
    if (cp >= 0x1FD0 && cp <= 0x1FDC) return CP_GROUP_LTR;
    if (cp >= 0x1FE0 && cp <= 0x1FEC) return CP_GROUP_LTR;
    if (cp >= 0x1FF2 && cp <= 0x1FFC) return CP_GROUP_LTR;
    /* Letterlike Symbols (subset that are letters) */
    if (cp >= 0x2100 && cp <= 0x214F) return CP_GROUP_LTR;
    /* Latin Extended-C, D, E */
    if (cp >= 0x2C60 && cp <= 0x2C7F) return CP_GROUP_LTR;
    if (cp >= 0xA720 && cp <= 0xA7FF) return CP_GROUP_LTR;
    if (cp >= 0xAB30 && cp <= 0xAB6F) return CP_GROUP_LTR;
    /* CJK (strong LTR) */
    if (cp >= 0x3000 && cp <= 0x9FFF) return CP_GROUP_LTR;
    if (cp >= 0xF900 && cp <= 0xFAFF) return CP_GROUP_LTR;
    /* Halfwidth/Fullwidth letters */
    if (cp >= 0xFF21 && cp <= 0xFF3A) return CP_GROUP_LTR;
    if (cp >= 0xFF41 && cp <= 0xFF5A) return CP_GROUP_LTR;

    /* Everything else (punctuation, symbols, digits, misc) is neutral */
    return CP_GROUP_NEUTRAL;
}

/* ============================================================
   Shuffle codepoints within a single group (by index list).
   ============================================================ */

static void shuffle_group(CmapEntry *entries, int *idx, int count, uint64_t *state)
{
    if (count < 2) return;

    uint32_t *cps = malloc(count * sizeof(uint32_t));
    for (int i = 0; i < count; i++)
        cps[i] = entries[idx[i]].codepoint;

    for (int i = count - 1; i > 0; i--) {
        uint32_t j = (uint32_t)(xorRand64(state) % (uint64_t)(i + 1));
        uint32_t tmp = cps[i];
        cps[i] = cps[j];
        cps[j] = tmp;
    }

    for (int i = 0; i < count; i++)
        entries[idx[i]].codepoint = cps[i];

    free(cps);
}

/* ============================================================
   Fisher-Yates shuffle on codepoint assignments.
   Codepoints are shuffled within their BiDi group:
     LTR letters, RTL letters, and neutral symbols separately.
   Combining/control/whitespace characters are not shuffled.
   ============================================================ */

static void fisher_yates_shuffle(CmapEntry *entries, int nentries, uint64_t seed)
{
    uint64_t state = seed ? seed : XORRAND64_DEFAULT_SEED;

    int *group_idx[CP_NUM_GROUPS];
    int  group_cnt[CP_NUM_GROUPS] = {0};

    for (int g = 0; g < CP_NUM_GROUPS; g++)
        group_idx[g] = malloc(nentries * sizeof(int));

    for (int i = 0; i < nentries; i++) {
        int g = classify_codepoint(entries[i].codepoint);
        group_idx[g][group_cnt[g]++] = i;
    }

    /* Shuffle each group (skip CP_GROUP_NONE) */
    for (int g = 1; g < CP_NUM_GROUPS; g++)
        shuffle_group(entries, group_idx[g], group_cnt[g], &state);

    for (int g = 0; g < CP_NUM_GROUPS; g++)
        free(group_idx[g]);
}

/* ============================================================
   Comparator for sorting CmapEntry by codepoint
   ============================================================ */

static int cmap_entry_cmp(const void *a, const void *b)
{
    uint32_t ca = ((const CmapEntry*)a)->codepoint;
    uint32_t cb = ((const CmapEntry*)b)->codepoint;
    if (ca < cb) return -1;
    if (ca > cb) return  1;
    return 0;
}

/* ============================================================
   Build a new cmap table in Format 12
   ============================================================ */

static uint8_t *build_cmap_format12(CmapEntry *entries, int nentries, uint32_t *outlen)
{
    /* Sort by codepoint */
    qsort(entries, nentries, sizeof(CmapEntry), cmap_entry_cmp);

    /* Merge into groups: consecutive codepoints with consecutive glyphIDs */
    typedef struct { uint32_t startChar, endChar, startGlyph; } Group;
    Group *groups = malloc(nentries * sizeof(Group));
    int ngroups = 0;

    if (nentries > 0) {
        groups[0].startChar  = entries[0].codepoint;
        groups[0].endChar    = entries[0].codepoint;
        groups[0].startGlyph = entries[0].glyphID;
        ngroups = 1;

        for (int i = 1; i < nentries; i++) {
            Group *g = &groups[ngroups - 1];
            if (entries[i].codepoint == g->endChar + 1 &&
                entries[i].glyphID == g->startGlyph + (entries[i].codepoint - g->startChar)) {
                g->endChar = entries[i].codepoint;
            } else {
                groups[ngroups].startChar  = entries[i].codepoint;
                groups[ngroups].endChar    = entries[i].codepoint;
                groups[ngroups].startGlyph = entries[i].glyphID;
                ngroups++;
            }
        }
    }

    /*
       cmap table layout:
       [cmap header]        4 bytes:  version(2) + numTables(2)
       [encoding record]    8 bytes:  platformID(2) + encodingID(2) + offset(4)
       [format 12 subtable]:
         format(2) + reserved(2) + length(4) + language(4) + numGroups(4) = 16 bytes header
         groups: numGroups * 12 bytes
    */
    uint32_t subtable_offset = 4 + 8;  /* after cmap header + 1 encoding record */
    uint32_t subtable_size = 16 + (uint32_t)ngroups * 12;
    uint32_t total_size = subtable_offset + subtable_size;

    /* Pad to 4-byte alignment */
    uint32_t padded_size = (total_size + 3) & ~3u;

    uint8_t *buf = calloc(1, padded_size);

    /* cmap header */
    WR16(buf + 0, 0);       /* version */
    WR16(buf + 2, 1);       /* numTables: 1 encoding record */

    /* encoding record: platformID=3 (Windows), encodingID=10 (full Unicode) */
    WR16(buf + 4, 3);       /* platformID */
    WR16(buf + 6, 10);      /* encodingID */
    WR32(buf + 8, subtable_offset);

    /* Format 12 subtable */
    uint8_t *st = buf + subtable_offset;
    WR16(st + 0, 12);       /* format */
    WR16(st + 2, 0);        /* reserved */
    WR32(st + 4, subtable_size);  /* length */
    WR32(st + 8, 0);        /* language */
    WR32(st + 12, (uint32_t)ngroups);

    for (int i = 0; i < ngroups; i++) {
        uint8_t *gp = st + 16 + i * 12;
        WR32(gp + 0, groups[i].startChar);
        WR32(gp + 4, groups[i].endChar);
        WR32(gp + 8, groups[i].startGlyph);
    }

    free(groups);
    *outlen = padded_size;
    return buf;
}

/* ============================================================
   Reassemble font with new cmap table
   ============================================================ */

static uint8_t *reassemble_font(const uint8_t *orig, size_t origlen,
                                const uint8_t *new_cmap, uint32_t new_cmap_len,
                                int cmap_table_index,
                                uint32_t orig_cmap_offset, uint32_t orig_cmap_length,
                                size_t *outlen)
{
    uint16_t numTables = RD16(orig + 4);

    /* Gather original table records */
    typedef struct {
        char tag[4];
        uint32_t orig_offset;
        uint32_t orig_length;
        uint32_t new_offset;
        uint32_t new_length;
    } TRec;

    TRec *tables = malloc(numTables * sizeof(TRec));

    for (uint16_t i = 0; i < numTables; i++) {
        const uint8_t *rec = orig + 12 + i * 16;
        memcpy(tables[i].tag, rec, 4);
        tables[i].orig_offset = RD32(rec + 8);
        tables[i].orig_length = RD32(rec + 12);
    }

    /* Sort tables by original offset to maintain order */
    /* Simple insertion sort (numTables is small) */
    for (int i = 1; i < numTables; i++) {
        TRec tmp = tables[i];
        int j = i - 1;
        while (j >= 0 && tables[j].orig_offset > tmp.orig_offset) {
            tables[j + 1] = tables[j];
            j--;
        }
        tables[j + 1] = tmp;
    }

    /* Find the cmap's position in the sorted order and remap the cmap_table_index */
    int sorted_cmap_idx = -1;
    for (int i = 0; i < numTables; i++) {
        if (tables[i].tag[0]=='c' && tables[i].tag[1]=='m' &&
            tables[i].tag[2]=='a' && tables[i].tag[3]=='p') {
            sorted_cmap_idx = i;
            break;
        }
    }

    /* Calculate new offsets: header(12) + table directory(numTables*16), then tables */
    uint32_t data_start = 12 + (uint32_t)numTables * 16;
    /* Align data_start to 4 bytes */
    data_start = (data_start + 3) & ~3u;

    uint32_t cur_offset = data_start;
    for (int i = 0; i < numTables; i++) {
        /* Align to 4 bytes */
        cur_offset = (cur_offset + 3) & ~3u;
        tables[i].new_offset = cur_offset;
        if (i == sorted_cmap_idx) {
            tables[i].new_length = new_cmap_len;
        } else {
            tables[i].new_length = tables[i].orig_length;
        }
        /* Advance by padded length */
        cur_offset += (tables[i].new_length + 3) & ~3u;
    }

    size_t total = cur_offset;
    uint8_t *out = calloc(1, total);

    /* Copy offset table header (first 12 bytes) */
    memcpy(out, orig, 12);

    /* Write table directory — but we need it sorted by tag for the directory,
       and we wrote tables in offset order. We need to find each table's directory
       slot. The directory order should match the original directory order.
       Actually, let's just write the directory entries in our sorted-by-offset order.
       The spec doesn't mandate directory order, but conventionally it's sorted by tag.
       Let's sort by tag for the directory. */

    /* Create an index array sorted by tag */
    int *tag_order = malloc(numTables * sizeof(int));
    for (int i = 0; i < numTables; i++) tag_order[i] = i;
    /* Bubble sort by tag (numTables is small) */
    for (int i = 0; i < numTables - 1; i++) {
        for (int j = 0; j < numTables - 1 - i; j++) {
            if (memcmp(tables[tag_order[j]].tag, tables[tag_order[j+1]].tag, 4) > 0) {
                int tmp = tag_order[j];
                tag_order[j] = tag_order[j+1];
                tag_order[j+1] = tmp;
            }
        }
    }

    /* Copy table data and write directory */
    for (int d = 0; d < numTables; d++) {
        int i = tag_order[d];
        uint8_t *dir_entry = out + 12 + d * 16;

        /* Copy table data */
        if (i == sorted_cmap_idx) {
            memcpy(out + tables[i].new_offset, new_cmap, new_cmap_len);
        } else {
            if (tables[i].orig_offset + tables[i].orig_length <= origlen)
                memcpy(out + tables[i].new_offset, orig + tables[i].orig_offset, tables[i].orig_length);
        }

        /* Write directory entry */
        memcpy(dir_entry, tables[i].tag, 4);
        WR32(dir_entry + 4, calc_checksum(out + tables[i].new_offset, tables[i].new_length));
        WR32(dir_entry + 8, tables[i].new_offset);
        WR32(dir_entry + 12, tables[i].new_length);
    }

    /* Fix head table checksumAdjustment:
       The head table has checksumAdjustment at byte offset 8.
       Set it to 0, compute checksum of whole file, then set it to 0xB1B0AFBA - checksum */
    for (int i = 0; i < numTables; i++) {
        if (tables[i].tag[0]=='h' && tables[i].tag[1]=='e' &&
            tables[i].tag[2]=='a' && tables[i].tag[3]=='d') {
            /* Zero out checksumAdjustment at head + 8 */
            WR32(out + tables[i].new_offset + 8, 0);
            uint32_t file_checksum = calc_checksum(out, (uint32_t)total);
            WR32(out + tables[i].new_offset + 8, 0xB1B0AFBA - file_checksum);

            /* Also update the head table's checksum in the directory */
            for (int d = 0; d < numTables; d++) {
                if (tag_order[d] == i) {
                    uint8_t *dir_entry = out + 12 + d * 16;
                    WR32(dir_entry + 4, calc_checksum(out + tables[i].new_offset, tables[i].new_length));
                    break;
                }
            }
            break;
        }
    }

    free(tag_order);
    free(tables);
    *outlen = total;
    return out;
}

/* ============================================================
   Exported Duktape function: obfuscateFont(fontBuffer, seed)
   ============================================================ */

static duk_ret_t do_obfuscate_font(duk_context *ctx)
{
    duk_size_t font_len;
    const uint8_t *font_data = (const uint8_t *)REQUIRE_BUFFER_DATA(ctx, 0, &font_len,
        "obfuscateFont: argument 1 must be a Buffer (font data)");
    uint64_t seed = (uint64_t)REQUIRE_NUMBER(ctx, 1,
        "obfuscateFont: argument 2 must be a number (seed)");

    /* Validate font magic */
    if (font_len < 12)
        RP_THROW(ctx, "obfuscateFont: font data too short");

    uint32_t magic = RD32(font_data);
    if (magic == 0x774F4646) /* wOFF */
        RP_THROW(ctx, "obfuscateFont: WOFF format not supported, convert to TTF/OTF first");
    if (magic == 0x774F4632) /* wOF2 */
        RP_THROW(ctx, "obfuscateFont: WOFF2 format not supported, convert to TTF/OTF first");
    if (magic == 0x74746366) /* ttcf */
        RP_THROW(ctx, "obfuscateFont: TTC font collections not supported");
    if (magic != 0x00010000 && magic != 0x4F54544F) /* TrueType or 'OTTO' (CFF) */
        RP_THROW(ctx, "obfuscateFont: unrecognized font format (magic: 0x%08x)", magic);

    /* Parse cmap */
    CmapEntryArray entries;
    cmap_array_init(&entries);
    uint32_t cmap_offset, cmap_length;
    int cmap_index;

    if (find_and_parse_cmap(font_data, font_len, &entries,
                            &cmap_offset, &cmap_length, &cmap_index) != 0) {
        cmap_array_free(&entries);
        RP_THROW(ctx, "obfuscateFont: failed to parse cmap table");
    }

    if (entries.count == 0) {
        cmap_array_free(&entries);
        RP_THROW(ctx, "obfuscateFont: cmap table has no mappings");
    }

    /* Save original codepoints for the mapping output */
    uint32_t *orig_codepoints = malloc(entries.count * sizeof(uint32_t));
    uint32_t *orig_glyphids   = malloc(entries.count * sizeof(uint32_t));
    for (int i = 0; i < entries.count; i++) {
        orig_codepoints[i] = entries.items[i].codepoint;
        orig_glyphids[i]   = entries.items[i].glyphID;
    }

    /* Shuffle */
    fisher_yates_shuffle(entries.items, entries.count, seed);

    /* Build new cmap table (Format 12) */
    uint32_t new_cmap_len;
    uint8_t *new_cmap = build_cmap_format12(entries.items, entries.count, &new_cmap_len);

    /* Reassemble font */
    size_t out_font_len;
    uint8_t *out_font = reassemble_font(font_data, font_len,
                                        new_cmap, new_cmap_len,
                                        cmap_index, cmap_offset, cmap_length,
                                        &out_font_len);

    /* Build return object: { font: Buffer, mapping: { "origCp": newCp, ... } } */
    duk_push_object(ctx);

    /* Push font buffer */
    void *buf = duk_push_fixed_buffer(ctx, out_font_len);
    memcpy(buf, out_font, out_font_len);
    duk_push_buffer_object(ctx, -1, 0, out_font_len, DUK_BUFOBJ_NODEJS_BUFFER);
    duk_remove(ctx, -2);  /* remove plain buffer, keep Buffer object */
    duk_put_prop_string(ctx, -2, "font");

    /* Push mapping: { "origCodepoint": newCodepoint, ... }
       Redo the deterministic shuffle to reconstruct the mapping
       (build_cmap_format12 sorted the entries array in place).
       Must replicate the same group partitioning. */
    {
        int n = entries.count;

        int *grp_idx[CP_NUM_GROUPS];
        int  grp_cnt[CP_NUM_GROUPS] = {0};
        for (int g = 0; g < CP_NUM_GROUPS; g++)
            grp_idx[g] = malloc(n * sizeof(int));

        for (int i = 0; i < n; i++) {
            int g = classify_codepoint(orig_codepoints[i]);
            grp_idx[g][grp_cnt[g]++] = i;
        }

        /* Replay the shuffle for each group with the same seed/state */
        uint32_t *shuffled = malloc(n * sizeof(uint32_t));
        memcpy(shuffled, orig_codepoints, n * sizeof(uint32_t));

        uint64_t state = seed ? seed : XORRAND64_DEFAULT_SEED;

        for (int g = 1; g < CP_NUM_GROUPS; g++) {
            int cnt = grp_cnt[g];
            if (cnt > 1) {
                uint32_t *cps = malloc(cnt * sizeof(uint32_t));
                for (int i = 0; i < cnt; i++)
                    cps[i] = orig_codepoints[grp_idx[g][i]];
                for (int i = cnt - 1; i > 0; i--) {
                    uint32_t j = (uint32_t)(xorRand64(&state) % (uint64_t)(i + 1));
                    uint32_t tmp = cps[i]; cps[i] = cps[j]; cps[j] = tmp;
                }
                for (int i = 0; i < cnt; i++)
                    shuffled[grp_idx[g][i]] = cps[i];
                free(cps);
            }
        }

        /* Build mapping: include all shuffled groups (skip NONE) */
        duk_push_object(ctx);
        char key[16];
        for (int g = 1; g < CP_NUM_GROUPS; g++) {
            for (int i = 0; i < grp_cnt[g]; i++) {
                int idx = grp_idx[g][i];
                snprintf(key, sizeof(key), "%u", orig_codepoints[idx]);
                duk_push_uint(ctx, shuffled[idx]);
                duk_put_prop_string(ctx, -2, key);
            }
        }
        duk_put_prop_string(ctx, -2, "mapping");

        free(shuffled);
        for (int g = 0; g < CP_NUM_GROUPS; g++)
            free(grp_idx[g]);
    }

    /* Cleanup */
    free(orig_codepoints);
    free(orig_glyphids);
    cmap_array_free(&entries);
    free(new_cmap);
    free(out_font);

    return 1;
}

/* ============================================================
   Exported: getCmap(fontBuffer)
   Returns { ltr: {cp: glyphID, ...}, rtl: {...}, neutral: {...} }
   ============================================================ */

static duk_ret_t do_get_cmap(duk_context *ctx)
{
    duk_size_t font_len;
    const uint8_t *font_data = (const uint8_t *)REQUIRE_BUFFER_DATA(ctx, 0, &font_len,
        "getCmap: argument must be a Buffer (font data)");

    if (font_len < 12)
        RP_THROW(ctx, "getCmap: font data too short");

    CmapEntryArray entries;
    cmap_array_init(&entries);
    uint32_t cmap_offset, cmap_length;
    int cmap_index;

    if (find_and_parse_cmap(font_data, font_len, &entries,
                            &cmap_offset, &cmap_length, &cmap_index) != 0) {
        cmap_array_free(&entries);
        RP_THROW(ctx, "getCmap: failed to parse cmap table");
    }

    /* Build result: { ltr: {}, rtl: {}, neutral: {} } */
    duk_push_object(ctx);  /* result */

    duk_push_object(ctx);  /* ltr */
    duk_push_object(ctx);  /* rtl */
    duk_push_object(ctx);  /* neutral */

    char key[16];
    for (int i = 0; i < entries.count; i++) {
        uint32_t cp = entries.items[i].codepoint;
        uint32_t gid = entries.items[i].glyphID;
        int group = classify_codepoint(cp);

        int stack_idx;
        switch (group) {
            case CP_GROUP_LTR:     stack_idx = -3; break;
            case CP_GROUP_RTL:     stack_idx = -2; break;
            case CP_GROUP_NEUTRAL: stack_idx = -1; break;
            default: continue; /* skip NONE */
        }

        snprintf(key, sizeof(key), "%u", cp);
        duk_push_uint(ctx, gid);
        duk_put_prop_string(ctx, stack_idx - 1, key); /* -1 for the value we just pushed */
    }

    duk_put_prop_string(ctx, -4, "neutral");
    duk_put_prop_string(ctx, -3, "rtl");
    duk_put_prop_string(ctx, -2, "ltr");

    cmap_array_free(&entries);
    return 1;
}

/* ============================================================
   Exported: buildFont(fontBuffer, cmapArray)
   cmapArray is [[codepoint, glyphID], ...]
   Returns Buffer with new font using the given cmap.
   ============================================================ */

static duk_ret_t do_build_font(duk_context *ctx)
{
    duk_size_t font_len;
    const uint8_t *font_data = (const uint8_t *)REQUIRE_BUFFER_DATA(ctx, 0, &font_len,
        "buildFont: argument 1 must be a Buffer (font data)");
    REQUIRE_ARRAY(ctx, 1, "buildFont: argument 2 must be an Array of [codepoint, glyphID] pairs");

    if (font_len < 12)
        RP_THROW(ctx, "buildFont: font data too short");

    /* Parse the original font to get table info */
    uint32_t orig_cmap_offset = 0, orig_cmap_length = 0;
    int cmap_index = -1;
    uint16_t numTables = RD16(font_data + 4);
    for (uint16_t i = 0; i < numTables; i++) {
        const uint8_t *rec = font_data + 12 + i * 16;
        if (rec[0]=='c' && rec[1]=='m' && rec[2]=='a' && rec[3]=='p') {
            orig_cmap_offset = RD32(rec + 8);
            orig_cmap_length = RD32(rec + 12);
            cmap_index = i;
            break;
        }
    }
    if (cmap_index < 0)
        RP_THROW(ctx, "buildFont: no cmap table found in font");

    /* Read the cmap array from JS */
    duk_size_t arr_len = duk_get_length(ctx, 1);
    CmapEntryArray entries;
    cmap_array_init(&entries);

    for (duk_size_t i = 0; i < arr_len; i++) {
        duk_get_prop_index(ctx, 1, (duk_uarridx_t)i);
        if (!duk_is_array(ctx, -1)) {
            duk_pop(ctx);
            continue;
        }
        duk_get_prop_index(ctx, -1, 0);
        uint32_t cp = (uint32_t)duk_get_uint(ctx, -1);
        duk_pop(ctx);
        duk_get_prop_index(ctx, -1, 1);
        uint32_t gid = (uint32_t)duk_get_uint(ctx, -1);
        duk_pop(ctx);
        duk_pop(ctx); /* pop the pair array */

        if (gid != 0)
            cmap_array_push(&entries, cp, gid);
    }

    if (entries.count == 0) {
        cmap_array_free(&entries);
        RP_THROW(ctx, "buildFont: cmap array is empty");
    }

    /* Build new cmap table */
    uint32_t new_cmap_len;
    uint8_t *new_cmap = build_cmap_format12(entries.items, entries.count, &new_cmap_len);

    /* Reassemble font */
    size_t out_font_len;
    uint8_t *out_font = reassemble_font(font_data, font_len,
                                        new_cmap, new_cmap_len,
                                        cmap_index, orig_cmap_offset, orig_cmap_length,
                                        &out_font_len);

    /* Push result buffer */
    void *buf = duk_push_fixed_buffer(ctx, out_font_len);
    memcpy(buf, out_font, out_font_len);
    duk_push_buffer_object(ctx, -1, 0, out_font_len, DUK_BUFOBJ_NODEJS_BUFFER);
    duk_remove(ctx, -2);

    cmap_array_free(&entries);
    free(new_cmap);
    free(out_font);

    return 1;
}

/* ============================================================
   Exported: shuffleTiles(rgbBuffer, width, height, tileSize, seed)
   Shuffles tile blocks in raw RGB pixel data.
   Returns Buffer with shuffled pixels.
   ============================================================ */

static duk_ret_t do_shuffle_tiles(duk_context *ctx)
{
    duk_size_t buf_len;
    const uint8_t *pixels = (const uint8_t *)REQUIRE_BUFFER_DATA(ctx, 0, &buf_len,
        "shuffleTiles: argument 1 must be a Buffer (RGB pixel data)");
    int width    = REQUIRE_INT(ctx, 1, "shuffleTiles: argument 2 must be a number (width)");
    int height   = REQUIRE_INT(ctx, 2, "shuffleTiles: argument 3 must be a number (height)");
    int tileSize = REQUIRE_INT(ctx, 3, "shuffleTiles: argument 4 must be a number (tileSize)");
    uint64_t seed = (uint64_t)REQUIRE_NUMBER(ctx, 4, "shuffleTiles: argument 5 must be a number (seed)");

    int channels = 3; /* PPM is RGB */
    size_t expected = (size_t)width * height * channels;
    if (buf_len < expected)
        RP_THROW(ctx, "shuffleTiles: buffer too small (%lu bytes, expected %lu)",
                 (unsigned long)buf_len, (unsigned long)expected);

    if (tileSize < 1) tileSize = 32;

    /* Pad dimensions to exact tile multiples */
    int padW = ((width  + tileSize - 1) / tileSize) * tileSize;
    int padH = ((height + tileSize - 1) / tileSize) * tileSize;
    int cols = padW / tileSize;
    int rows = padH / tileSize;
    int ntiles = cols * rows;

    /* Create padded source: copy original rows, zero-pad right and bottom */
    int srcStride = width * channels;
    int padStride = padW * channels;
    size_t padSize = (size_t)padStride * padH;
    uint8_t *padded = calloc(1, padSize); /* zeros = black padding */
    for (int y = 0; y < height; y++)
        memcpy(padded + y * padStride, pixels + y * srcStride, srcStride);

    /* Build tile index and shuffle */
    int *perm = malloc(ntiles * sizeof(int));
    for (int i = 0; i < ntiles; i++) perm[i] = i;

    uint64_t state = seed ? seed : XORRAND64_DEFAULT_SEED;
    for (int i = ntiles - 1; i > 0; i--) {
        int j = (int)(xorRand64(&state) % (uint64_t)(i + 1));
        int tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp;
    }

    /* Allocate output and copy tiles in shuffled order.
       All tiles are now exactly tileSize x tileSize (no edge issues). */
    uint8_t *out = calloc(1, padSize);

    for (int i = 0; i < ntiles; i++) {
        int src_idx = perm[i];
        int src_x = (src_idx % cols) * tileSize;
        int src_y = (src_idx / cols) * tileSize;
        int dst_x = (i % cols) * tileSize;
        int dst_y = (i / cols) * tileSize;
        int copyBytes = tileSize * channels;

        for (int row = 0; row < tileSize; row++) {
            const uint8_t *sp = padded + (src_y + row) * padStride + src_x * channels;
            uint8_t       *dp = out    + (dst_y + row) * padStride + dst_x * channels;
            memcpy(dp, sp, copyBytes);
        }
    }

    /* Return the padded-size output (caller uses padded dimensions for PPM) */
    void *buf = duk_push_fixed_buffer(ctx, padSize);
    memcpy(buf, out, padSize);
    duk_push_buffer_object(ctx, -1, 0, padSize, DUK_BUFOBJ_NODEJS_BUFFER);
    duk_remove(ctx, -2);

    free(perm);
    free(out);
    free(padded);

    return 1;
}

/* ============================================================
   Initialize module
   ============================================================ */
duk_ret_t duk_open_module(duk_context *ctx)
{
    duk_push_object(ctx);

    duk_push_c_function(ctx, do_obfuscate_font, 2);
    duk_put_prop_string(ctx, -2, "obfuscateFont");

    duk_push_c_function(ctx, do_get_cmap, 1);
    duk_put_prop_string(ctx, -2, "getCmap");

    duk_push_c_function(ctx, do_build_font, 2);
    duk_put_prop_string(ctx, -2, "buildFont");

    duk_push_c_function(ctx, do_shuffle_tiles, 5);
    duk_put_prop_string(ctx, -2, "shuffleTiles");

    return 1;
}
