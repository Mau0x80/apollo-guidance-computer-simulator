/**
 * AGC ROM Loader
 *
 * Infrastructure for loading a pre-assembled AGC binary ROM into the
 * emulated fixed-memory banks and transferring control to the AGC CPU.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW REAL ROM EXECUTION WORKS (planned pipeline):
 *
 *  1. The 127 .s source files (Comanche 055 + Luminary 099) are assembled
 *     offline by tools/assembler/yayul.js into a binary ROM image.
 *
 *  2. The binary is stored as agc-rom.bin (raw 15-bit words, big-endian)
 *     or as agc-rom.js (a pre-loaded Uint16Array for browser use).
 *
 *  3. AGCROMLoader.load(agc, romWords) maps the flat word array into the
 *     36 fixed-memory banks of the AGCCore instance.
 *
 *  4. AGCCore.start() is called; the CPU begins executing from the
 *     FRESH_START_AND_RESTART vector (octal 04000).
 *
 *  5. The EXECUTIVE scheduler boots, starts WAITLIST tasks, and eventually
 *     PINBALL_GAME_BUTTONS_AND_LIGHTS takes over the DSKY — at which point
 *     the software PINBALL state machine in pinball.js is no longer needed
 *     because the real AGC program handles all VERB/NOUN input via KEYRUPT.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * MEMORY MAP (yaYUL / AGC convention):
 *
 *   Erasable memory (8 banks × 256 words = 2048 words):
 *     Bank 0: 0000–0377  (octal)  ← special registers + unswitched erasable
 *     Banks 1–7: switched via EB register
 *
 *   Fixed memory (36 banks × 1024 words = 36864 words):
 *     Banks 00–01: fixed-fixed common (always accessible at 04000–05777)
 *     Banks 02–03: also fixed-fixed (accessible at 06000–07777)
 *     Banks 04–037: switched fixed, addressed via FB register
 *
 *   The assembled ROM image is a flat array of 36 × 1024 = 36,864 words.
 *   Word 0 = bank 00, word 0
 *   Word 1023 = bank 00, word 1023
 *   Word 1024 = bank 01, word 0
 *   … etc.
 *
 * ─────────────────────────────────────────────────────────────────────────
 */

'use strict';

const ROM_BANKS       = 36;
const ROM_BANK_SIZE   = 1024;   // words per bank
const ROM_TOTAL_WORDS = ROM_BANKS * ROM_BANK_SIZE;  // 36,864

class AGCROMLoader {
  constructor() {
    this.loaded    = false;
    this.wordCount = 0;
    this.checksum  = 0;
  }

  // -------------------------------------------------------------------------
  // Load a flat Uint16Array (or regular Array) of 15-bit words into AGCCore.
  //
  // romWords: Uint16Array of length ROM_TOTAL_WORDS (36,864)
  //   Each word is a 15-bit value (bits 14-0 used; bit 15 is parity in
  //   the original hardware but ignored here).
  //
  // Returns true on success, false if the word count is wrong.
  // -------------------------------------------------------------------------
  load(agc, romWords) {
    if (!romWords || romWords.length < ROM_TOTAL_WORDS) {
      console.warn(`[AGCROMLoader] ROM too short: got ${romWords?.length}, need ${ROM_TOTAL_WORDS}`);
      return false;
    }

    let checksum = 0;
    for (let bank = 0; bank < ROM_BANKS; bank++) {
      const bankWords = new Uint16Array(ROM_BANK_SIZE);
      for (let i = 0; i < ROM_BANK_SIZE; i++) {
        const w = romWords[bank * ROM_BANK_SIZE + i] & 0x7FFF;
        bankWords[i] = w;
        checksum ^= w;
      }
      agc.loadBank(bank, bankWords);
    }

    this.loaded    = true;
    this.wordCount = romWords.length;
    this.checksum  = checksum;

    console.info(
      `[AGCROMLoader] ROM loaded: ${ROM_BANKS} banks × ${ROM_BANK_SIZE} words`,
      `| checksum 0x${checksum.toString(16).padStart(4,'0')}`
    );
    return true;
  }

  // -------------------------------------------------------------------------
  // Load ROM from a .bin file fetched via HTTP (or file://).
  // The binary is stored as 2 bytes per word, big-endian (matches yaYUL output).
  // -------------------------------------------------------------------------
  async loadFromURL(agc, url) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      const bytes  = new Uint8Array(buffer);

      // 2 bytes per 15-bit word, big-endian
      const words = new Uint16Array(bytes.length / 2);
      for (let i = 0; i < words.length; i++) {
        words[i] = ((bytes[i * 2] << 8) | bytes[i * 2 + 1]) & 0x7FFF;
      }

      return this.load(agc, words);
    } catch (err) {
      console.error('[AGCROMLoader] Failed to load ROM from URL:', url, err);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Attempt to load the pre-assembled ROM (if it exists in the repo).
  // Falls back gracefully if the file is not found — the simulator continues
  // running in telemetry-driven demo mode.
  // -------------------------------------------------------------------------
  async tryAutoLoad(agc) {
    const candidates = [
      'js/agc-rom.bin',
      '../tools/assembler/agc-rom.bin',
    ];

    for (const url of candidates) {
      const ok = await this.loadFromURL(agc, url);
      if (ok) {
        console.info('[AGCROMLoader] Auto-loaded ROM from', url);
        agc.start();
        return true;
      }
    }

    console.info(
      '[AGCROMLoader] No pre-assembled ROM found. Running in telemetry-demo mode.\n' +
      'To enable full ROM execution:\n' +
      '  node tools/assembler/yayul.js --out simulator/js/agc-rom.bin'
    );
    return false;
  }

  // -------------------------------------------------------------------------
  // Diagnostic: print the first N words of each bank to the console.
  // -------------------------------------------------------------------------
  dump(agc, wordsPerBank = 8) {
    if (!this.loaded) { console.warn('[AGCROMLoader] No ROM loaded'); return; }
    for (let bank = 0; bank < ROM_BANKS; bank++) {
      const words = [];
      for (let i = 0; i < wordsPerBank; i++) {
        const addr = (bank >= 4 ? 0o4000 : 0o2000) + i;
        words.push(agc.fixed[bank][i].toString(8).padStart(5, '0'));
      }
      console.log(`Bank ${bank.toString().padStart(2,'0')}: ${words.join(' ')}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------
if (typeof module !== 'undefined') module.exports = { AGCROMLoader, ROM_BANKS, ROM_BANK_SIZE };
else window.AGCROMLoader = AGCROMLoader;
