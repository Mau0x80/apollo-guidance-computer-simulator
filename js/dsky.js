/**
 * DSKY — Display & Keyboard Interface
 *
 * The DSKY communicates with the AGC via I/O channels:
 *   Channel 010 (octal) — AGC writes 7-segment digit data
 *   Channel 011 (octal) — AGC writes relay/light control
 *   Channel 013 (octal) — AGC reads DSKY discrete inputs
 *   Channel 015 (octal) — Keyboard sends key codes (KEYRUPT1)
 *
 * Channel 010 word format (15 bits):
 *   Bits 14-11: digit select (which display position)
 *   Bits 10-6 : tens digit data (BCD + sign)
 *   Bits  5-1 : units digit data (BCD + sign)
 *   Bit   0   : (unused / relay)
 *
 * Channel 011 word format (relay word — lights):
 *   Bit 11: COMP ACTY light
 *   Bit 10: UPLINK ACTY
 *   ...etc
 *
 * Key codes (5-bit, sent via channel 015):
 *   00001 = 1,  00010 = 2, ... 01010 = 0
 *   11101 = VERB,  11110 = NOUN
 *   10000 = +,     10001 = -
 *   11000 = CLR,   11001 = PRO
 *   11010 = KEY REL, 11011 = ENTR
 *   11111 = RSET
 */

'use strict';

// Key codes (5-bit values sent to AGC via channel 015)
const KEYCODES = {
  '1': 0b00001,  '2': 0b00010,  '3': 0b00011,
  '4': 0b00100,  '5': 0b00101,  '6': 0b00110,
  '7': 0b00111,  '8': 0b01000,  '9': 0b01001,
  '0': 0b01010,
  'VERB':   0b11101,
  'NOUN':   0b11110,
  '+':      0b10000,
  '-':      0b10001,
  'CLR':    0b11000,
  'PRO':    0b11001,
  'KEYREL': 0b11010,
  'ENTR':   0b11011,
  'RSET':   0b11111,
};

// Light bit positions in channel 011
const LIGHT_BITS = {
  COMP_ACTY:    11,
  UPLINK_ACTY:  10,
  TEMP:          9,
  GIMBAL_LOCK:   8,
  PROG:          7,
  RESTART:       6,
  TRACKER:       5,
  ALT:           4,
  VEL:           3,
  NO_ATT:        2,
  OPR_ERR:       1,
  KEY_REL:       0,
};

class DSKY {
  constructor(agc) {
    this.agc = agc;

    // Display state
    this.verb  = '--';
    this.noun  = '--';
    this.prog  = '--';
    this.r1    = [' ', ' ', ' ', ' ', ' ', ' ']; // sign + 5 digits
    this.r2    = [' ', ' ', ' ', ' ', ' ', ' '];
    this.r3    = [' ', ' ', ' ', ' ', ' ', ' '];

    // Warning lights
    this.lights = {
      UPLINK_ACTY:  false,
      NO_ATT:       false,
      STBY:         false,
      KEY_REL:      false,
      OPR_ERR:      false,
      TEMP:         false,
      GIMBAL_LOCK:  false,
      PROG:         false,
      RESTART:      false,
      TRACKER:      false,
      ALT:          false,
      VEL:          false,
      COMP_ACTY:    false,
    };

    // Flash state
    this.verbFlash = false;
    this.nounFlash = false;

    // Blanked state
    this.displayBlanked = false;

    // Internal raw channel values
    this._chan10 = 0;
    this._chan11 = 0;

    // UI callback — set by main.js after DOM is ready
    this.onUpdate = null;

    // Register channel handler with AGC
    if (agc) {
      agc.onDSKYOutput = (ch, val) => this._handleChannel(ch, val);
    }

    // Flashing interval (verb/noun flash at ~1.5 Hz)
    this._flashState = false;
    setInterval(() => {
      this._flashState = !this._flashState;
      if (this.onUpdate) this.onUpdate();
    }, 333);
  }

  // -------------------------------------------------------------------------
  // Channel handler (called by AGC when it writes channels 010–014)
  // -------------------------------------------------------------------------
  _handleChannel(ch, val) {
    switch (ch) {
      case 0o10: this._decodeChan10(val); break;
      case 0o11: this._decodeChan11(val); break;
      case 0o13: this._decodeChan13(val); break;
    }
    if (this.onUpdate) this.onUpdate();
  }

  // Channel 010: digit display
  // Bits 14-11: position selector; 10-6: tens; 5-1: units; bit0: spare
  _decodeChan10(val) {
    this._chan10 = val;

    const pos    = (val >> 11) & 0xF;
    const tensBCD  = (val >> 6)  & 0x1F;
    const unitsBCD = (val >> 1)  & 0x1F;

    const tens  = this._bcdDigit(tensBCD);
    const units = this._bcdDigit(unitsBCD);

    switch (pos) {
      case 0o21: // PROG display tens/units
        this.prog = tens + units;
        break;
      case 0o22: // VERB display tens/units
        this.verb = tens + units;
        break;
      case 0o23: // NOUN display tens/units
        this.noun = tens + units;
        break;
      case 0o01: // R1 sign + digit 1
        this.r1[0] = this._sign(tensBCD);
        this.r1[1] = units;
        break;
      case 0o02: // R1 digits 2-3
        this.r1[2] = tens;
        this.r1[3] = units;
        break;
      case 0o03: // R1 digits 4-5
        this.r1[4] = tens;
        this.r1[5] = units;
        break;
      case 0o04: // R2 sign + digit 1
        this.r2[0] = this._sign(tensBCD);
        this.r2[1] = units;
        break;
      case 0o05: // R2 digits 2-3
        this.r2[2] = tens;
        this.r2[3] = units;
        break;
      case 0o06: // R2 digits 4-5
        this.r2[4] = tens;
        this.r2[5] = units;
        break;
      case 0o07: // R3 sign + digit 1
        this.r3[0] = this._sign(tensBCD);
        this.r3[1] = units;
        break;
      case 0o10: // R3 digits 2-3
        this.r3[2] = tens;
        this.r3[3] = units;
        break;
      case 0o11: // R3 digits 4-5
        this.r3[4] = tens;
        this.r3[5] = units;
        break;
      default:
        break;
    }
  }

  // Channel 011: relay word (lights & flash control)
  _decodeChan11(val) {
    this._chan11 = val;
    this.lights.COMP_ACTY   = !!(val & (1 << LIGHT_BITS.COMP_ACTY));
    this.lights.UPLINK_ACTY = !!(val & (1 << LIGHT_BITS.UPLINK_ACTY));
    this.lights.TEMP         = !!(val & (1 << LIGHT_BITS.TEMP));
    this.lights.GIMBAL_LOCK  = !!(val & (1 << LIGHT_BITS.GIMBAL_LOCK));
    this.lights.PROG         = !!(val & (1 << LIGHT_BITS.PROG));
    this.lights.RESTART      = !!(val & (1 << LIGHT_BITS.RESTART));
    this.lights.TRACKER      = !!(val & (1 << LIGHT_BITS.TRACKER));
    this.lights.ALT          = !!(val & (1 << LIGHT_BITS.ALT));
    this.lights.VEL          = !!(val & (1 << LIGHT_BITS.VEL));
    this.lights.NO_ATT       = !!(val & (1 << LIGHT_BITS.NO_ATT));
    this.lights.OPR_ERR      = !!(val & (1 << LIGHT_BITS.OPR_ERR));
    this.lights.KEY_REL      = !!(val & (1 << LIGHT_BITS.KEY_REL));

    // Verb/Noun flash driven by relay word (bit 12 / 13 in some implementations)
    // We'll toggle on bit 12 for VERB flash, bit 13 for NOUN flash
    this.verbFlash = !!(val & (1 << 12));
    this.nounFlash = !!(val & (1 << 13));
  }

  // Channel 013: discrete inputs (DSKY → AGC direction)
  _decodeChan13(val) {
    // Bit 11 = display blanked, bit 0 = DSKY standby
    this.displayBlanked = !!(val & (1 << 11));
    this.lights.STBY    = !!(val & 1);
  }

  // BCD decode for a 5-bit segment value
  _bcdDigit(bcd) {
    if (bcd === 0)     return ' ';
    if (bcd >= 0b00001 && bcd <= 0b01010) {
      // Actual BCD: 1→1, 2→2, ..., 10→0
      return String(bcd === 0b01010 ? 0 : bcd);
    }
    // Blank
    return ' ';
  }

  _sign(bcd) {
    if (bcd === 0b10000) return '+';
    if (bcd === 0b10001) return '-';
    return ' ';
  }

  // -------------------------------------------------------------------------
  // Keyboard input — called by UI when user presses a DSKY key
  // -------------------------------------------------------------------------
  pressKey(keyName) {
    const code = KEYCODES[keyName];
    if (code === undefined) return;
    if (this.agc) {
      this.agc.triggerKeyrupt1(code);
    }
    // Light COMP ACTY briefly
    this.lights.COMP_ACTY = true;
    setTimeout(() => { this.lights.COMP_ACTY = false; if (this.onUpdate) this.onUpdate(); }, 200);
  }

  // -------------------------------------------------------------------------
  // Simulate AGC writing display data (for demo mode without real AGC ROM)
  // -------------------------------------------------------------------------
  setDisplay({ verb, noun, prog, r1, r2, r3, lights } = {}) {
    if (verb  !== undefined) this.verb  = String(verb).padStart(2,'0');
    if (noun  !== undefined) this.noun  = String(noun).padStart(2,'0');
    if (prog  !== undefined) this.prog  = String(prog).padStart(2,'0');
    if (r1    !== undefined) this._setRegister(this.r1, r1);
    if (r2    !== undefined) this._setRegister(this.r2, r2);
    if (r3    !== undefined) this._setRegister(this.r3, r3);
    if (lights !== undefined) {
      Object.assign(this.lights, lights);
    }
    if (this.onUpdate) this.onUpdate();
  }

  _setRegister(reg, val) {
    // val can be a signed number or a string like "+00000"
    if (typeof val === 'number') {
      const sign = val < 0 ? '-' : '+';
      const abs  = Math.abs(val).toString().padStart(5, '0');
      reg[0] = sign;
      for (let i = 0; i < 5; i++) reg[i+1] = abs[i];
    } else {
      const s = String(val).padStart(6, ' ');
      for (let i = 0; i < 6; i++) reg[i] = s[i] || ' ';
    }
  }

  // -------------------------------------------------------------------------
  // Get full display snapshot (used by UI renderer)
  // -------------------------------------------------------------------------
  getState() {
    return {
      verb:  this.verbFlash && this._flashState ? '--' : this.verb,
      noun:  this.nounFlash && this._flashState ? '--' : this.noun,
      prog:  this.prog,
      r1:    [...this.r1],
      r2:    [...this.r2],
      r3:    [...this.r3],
      lights: { ...this.lights },
      blanked: this.displayBlanked,
    };
  }
}

if (typeof module !== 'undefined') module.exports = { DSKY, KEYCODES, LIGHT_BITS };
else window.DSKY = DSKY;
