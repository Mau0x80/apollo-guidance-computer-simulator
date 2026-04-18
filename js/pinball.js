/**
 * PINBALL — AGC Display & Keyboard State Machine
 *
 * Mirrors the behavior of PINBALL_GAME_BUTTONS_AND_LIGHTS.s
 * (Comanche 055, pages 817–1106 of the original hardcopy).
 *
 * Responsibilities:
 *   - Accept key presses from the DSKY keyboard
 *   - Maintain VERB/NOUN entry state machine
 *   - Validate verb/noun combinations
 *   - Drive DSKY display feedback (flashing, partial entry, OPR ERR)
 *   - Signal the mission simulator when user takes display control
 *
 * State machine:
 *   IDLE → (VERB key) → VERB_1 → VERB_2 → (ENTR or NOUN) →
 *   NOUN_1 → NOUN_2 → (ENTR) → execute → IDLE
 *   Any state → PRO_WAIT → (PRO) → IDLE
 */

'use strict';

// ---------------------------------------------------------------------------
// Noun data map — what each noun displays in R1/R2/R3
// Keys map to the phase data fields or special computations.
// ---------------------------------------------------------------------------
const NOUN_META = {
   5: { r1: 'Alarm code',        r2: '—',               r3: '—'            },
   9: { r1: 'Alarm code',        r2: '—',               r3: '—'            },
  15: { r1: 'Time (hr)',         r2: 'Time (min)',       r3: 'Time (sec)'   },
  17: { r1: 'Time to ignition',  r2: '—',               r3: '—'            },
  18: { r1: 'Yaw (deg)',         r2: 'Pitch (deg)',      r3: 'Roll (deg)'   },
  20: { r1: 'OGA (deg)',         r2: 'IMU pitch',        r3: 'IMU roll'     },
  30: { r1: 'Prog change',       r2: '—',               r3: '—'            },
  33: { r1: 'Ignition time',     r2: '—',               r3: '—'            },
  36: { r1: 'GET (csec)',        r2: '—',               r3: '—'            },
  40: { r1: 'Δv required',       r2: 'Time to ignite',  r3: '—'            },
  42: { r1: 'Apogee (nm)',       r2: 'Perigee (nm)',     r3: '—'            },
  43: { r1: 'Altitude (nm)',     r2: 'Alt rate (fps)',   r3: '—'            },
  44: { r1: 'Time of event',     r2: '—',               r3: '—'            },
  54: { r1: 'Δvx (fps)',         r2: 'Δvy (fps)',        r3: 'Δvz (fps)'    },
  59: { r1: 'Alt rate (fps)',    r2: 'Altitude (ft)',    r3: '—'            },
  61: { r1: 'Velocity (fps)',    r2: 'Entry angle',      r3: 'Lift vector'  },
  62: { r1: 'Velocity (fps)',    r2: 'Alt rate (fps)',   r3: 'Altitude (nm)'},
  63: { r1: 'Altitude (ft)',     r2: 'Velocity (fps)',   r3: 'Range (nm)'   },
  64: { r1: 'Altitude (ft)',     r2: 'Alt rate (fps)',   r3: 'Cross rng (ft)'},
  65: { r1: 'Altitude (ft)',     r2: 'Alt rate (fps)',   r3: '—'            },
  67: { r1: 'Altitude (ft)',     r2: 'Lat error (ft)',   r3: 'Lng error (ft)'},
  68: { r1: 'Altitude (ft)',     r2: 'Desc rate (fps)',  r3: '—'            },
  69: { r1: 'Alarm code',        r2: '—',               r3: '—'            },
};

// Valid verb/noun pairs (subset of the full AGC noun table)
const VALID_VERBS = new Set([
   5,  6, 11, 16, 17, 21, 22, 23, 24, 25,
  32, 33, 34, 35, 36, 37, 40, 41, 49, 50,
  51, 55, 57, 64, 69, 82, 83, 89, 91, 93,
  96, 97, 99,
]);

// ---------------------------------------------------------------------------
class Pinball {
  constructor(dsky) {
    this.dsky = dsky;

    // ---- state machine ----
    this.state = 'IDLE';
    // Possible states: IDLE | VERB_1 | VERB_2 | NOUN_1 | NOUN_2 | PRO_WAIT

    // ---- entry buffers ----
    this.verbBuf    = '';   // digits typed so far for VERB
    this.nounBuf    = '';   // digits typed so far for NOUN
    this.pendingVerb = null; // locked verb waiting for noun

    // ---- active (committed) values ----
    this.activeVerb = '06';
    this.activeNoun = '62';
    this.activeProg = '11';

    // ---- user control flag ----
    // When true: MissionSimulator will NOT override verb/noun/prog display.
    // R1/R2/R3 are still driven by telemetry for the locked noun.
    this.userControlled = false;

    // ---- PRO confirmation ----
    this.proAction = null;  // { type: 'perform' | 'program', data }

    // ---- V35 test-lights timer ----
    this._testTimer = null;
  }

  // -------------------------------------------------------------------------
  // Main entry point — called by AGCUI._dskyKey() for every key press.
  // Returns nothing; directly updates DSKY display.
  // -------------------------------------------------------------------------
  onKey(key) {
    switch (this.state) {
      case 'IDLE':     this._idleKey(key);    break;
      case 'VERB_1':
      case 'VERB_2':   this._verbKey(key);    break;
      case 'NOUN_1':
      case 'NOUN_2':   this._nounKey(key);    break;
      case 'PRO_WAIT': this._proWaitKey(key); break;
    }
  }

  // -------------------------------------------------------------------------
  // IDLE — no entry in progress
  // -------------------------------------------------------------------------
  _idleKey(key) {
    if (key === 'VERB') {
      this.state   = 'VERB_1';
      this.verbBuf = '';
      this.dsky.verbFlash = true;
      this.dsky.setDisplay({ verb: '  ' });

    } else if (key === 'NOUN') {
      this.state   = 'NOUN_1';
      this.nounBuf = '';
      this.dsky.nounFlash = true;
      this.dsky.setDisplay({ noun: '  ' });

    } else if (key === 'PRO') {
      if (this.proAction) this._executePro();

    } else if (key === 'RSET') {
      this.dsky.setDisplay({
        lights: { OPR_ERR: false, RESTART: false, KEY_REL: false, TRACKER: false },
      });

    } else if (key === 'KEYREL') {
      this.dsky.setDisplay({ lights: { KEY_REL: false } });
    }
    // Numeric keys in IDLE mode are silently ignored (real DSKY behavior)
  }

  // -------------------------------------------------------------------------
  // VERB entry (VERB_1 = waiting for 1st digit, VERB_2 = waiting for 2nd)
  // -------------------------------------------------------------------------
  _verbKey(key) {
    if (key >= '0' && key <= '9') {
      this.verbBuf += key;
      if (this.state === 'VERB_1') {
        this.state = 'VERB_2';
        this.dsky.setDisplay({ verb: key + ' ' });
      } else {
        // Both digits entered — show them, wait for ENTR or NOUN
        this.dsky.setDisplay({ verb: this.verbBuf });
      }

    } else if (key === 'ENTR') {
      if (!this.verbBuf) { this._operError(); return; }
      const verb = this.verbBuf.padStart(2, '0');
      this.dsky.verbFlash = false;
      this.state = 'IDLE';
      this._processVerbOnly(verb);

    } else if (key === 'NOUN') {
      // Switch to noun entry, keeping verb
      if (this.verbBuf) this.pendingVerb = this.verbBuf.padStart(2, '0');
      this.state   = 'NOUN_1';
      this.nounBuf = '';
      this.dsky.verbFlash = false;
      this.dsky.nounFlash = true;
      this.dsky.setDisplay({
        verb: this.pendingVerb || this.activeVerb,
        noun: '  ',
      });

    } else if (key === 'CLR') {
      this.verbBuf = '';
      this.state   = 'VERB_1';
      this.dsky.setDisplay({ verb: '  ' });

    } else if (key === 'RSET') {
      this._reset();
    }
  }

  // -------------------------------------------------------------------------
  // NOUN entry (NOUN_1 / NOUN_2)
  // -------------------------------------------------------------------------
  _nounKey(key) {
    if (key >= '0' && key <= '9') {
      this.nounBuf += key;
      if (this.state === 'NOUN_1') {
        this.state = 'NOUN_2';
        this.dsky.setDisplay({ noun: key + ' ' });
      } else {
        this.dsky.setDisplay({ noun: this.nounBuf });
      }

    } else if (key === 'ENTR') {
      if (!this.nounBuf) { this._operError(); return; }
      const noun = this.nounBuf.padStart(2, '0');
      const verb = this.pendingVerb || this.activeVerb;
      this.dsky.nounFlash = false;
      this.dsky.verbFlash = false;
      this.state       = 'IDLE';
      this.pendingVerb = null;
      this._processVerbNoun(verb, noun);

    } else if (key === 'CLR') {
      this.nounBuf = '';
      this.state   = 'NOUN_1';
      this.dsky.setDisplay({ noun: '  ' });

    } else if (key === 'RSET') {
      this._reset();
    }
  }

  // -------------------------------------------------------------------------
  // PRO_WAIT — waiting for crew to confirm with PRO
  // -------------------------------------------------------------------------
  _proWaitKey(key) {
    if (key === 'PRO')  this._executePro();
    if (key === 'RSET') this._reset();
  }

  // -------------------------------------------------------------------------
  // Process verb alone (no noun entered yet)
  // -------------------------------------------------------------------------
  _processVerbOnly(verb) {
    const v = parseInt(verb, 10);
    switch (v) {
      case 34: this._terminate();  return;
      case 35: this._testLights(); return;
      case 36: this._freshStart(); return;
      case 69: this._freshStart(); return;
    }
    // All other verbs need a noun — enter noun-entry mode
    this.pendingVerb = verb;
    this.state       = 'NOUN_1';
    this.nounBuf     = '';
    this.dsky.nounFlash = true;
    this.dsky.setDisplay({ verb, verbFlash: false, noun: '  ' });
  }

  // -------------------------------------------------------------------------
  // Execute VERB + NOUN combination
  // -------------------------------------------------------------------------
  _processVerbNoun(verb, noun) {
    const v = parseInt(verb, 10);
    const n = parseInt(noun, 10);

    if (!VALID_VERBS.has(v) || n < 0 || n > 99) {
      this._operError();
      return;
    }

    this.activeVerb     = verb;
    this.activeNoun     = noun;
    this.userControlled = true;

    this.dsky.setDisplay({ verb, noun, lights: { OPR_ERR: false } });

    if (v === 37) { this._changeProgram(n);      return; }
    if (v === 99) { this._pleasePerform(noun);   return; }

    // V06, V16, V05, V32, V11, etc. — just display data for noun
    // R1/R2/R3 are updated by MissionSimulator using the locked noun
    this._updateRegLabels(n);
  }

  // -------------------------------------------------------------------------
  // V37 — Change major mode (program)
  // -------------------------------------------------------------------------
  _changeProgram(prog) {
    const p = prog.toString().padStart(2, '0');
    this.activeProg = p;
    this.dsky.setDisplay({ prog: p, lights: { PROG: true, OPR_ERR: false } });
    // PROG light stays on for 2 s then extinguishes
    setTimeout(() => this.dsky.setDisplay({ lights: { PROG: false } }), 2000);
  }

  // -------------------------------------------------------------------------
  // V99 — Please perform (requires PRO confirmation)
  // -------------------------------------------------------------------------
  _pleasePerform(noun) {
    this.proAction = { type: 'perform', noun };
    this.state     = 'PRO_WAIT';
    this.dsky.verbFlash = true;
    this.dsky.nounFlash = true;
    this.dsky.setDisplay({ lights: { KEY_REL: true } });
  }

  // -------------------------------------------------------------------------
  // PRO key pressed during PRO_WAIT
  // -------------------------------------------------------------------------
  _executePro() {
    this.state     = 'IDLE';
    this.proAction = null;
    this.dsky.verbFlash = false;
    this.dsky.nounFlash = false;
    this.dsky.setDisplay({ lights: { KEY_REL: false } });
  }

  // -------------------------------------------------------------------------
  // V35 — Test all display lights and segments
  // -------------------------------------------------------------------------
  _testLights() {
    this.state = 'IDLE';
    if (this._testTimer) clearTimeout(this._testTimer);

    const allOn = {
      UPLINK_ACTY: true, NO_ATT: true, STBY: true, KEY_REL: true,
      OPR_ERR: true, COMP_ACTY: true, TEMP: true, GIMBAL_LOCK: true,
      PROG: true, RESTART: true, TRACKER: true, ALT: true, VEL: true,
    };
    this.dsky.setDisplay({
      prog: '88', verb: '88', noun: '88',
      r1: '+88888', r2: '+88888', r3: '+88888',
      lights: allOn,
    });

    this._testTimer = setTimeout(() => {
      const allOff = Object.fromEntries(Object.keys(allOn).map(k => [k, false]));
      this.dsky.setDisplay({ lights: allOff });
      this.userControlled = false;
    }, 5000);
  }

  // -------------------------------------------------------------------------
  // V34 — Terminate current program display
  // -------------------------------------------------------------------------
  _terminate() {
    this.state          = 'IDLE';
    this.userControlled = false;
    this.dsky.verbFlash = false;
    this.dsky.nounFlash = false;
    this.dsky.setDisplay({ verb: '34', lights: { OPR_ERR: false } });
  }

  // -------------------------------------------------------------------------
  // V36 / V69 — Fresh start
  // -------------------------------------------------------------------------
  _freshStart() {
    this.state          = 'IDLE';
    this.activeVerb     = '00';
    this.activeNoun     = '00';
    this.activeProg     = '00';
    this.userControlled = false;
    this.dsky.verbFlash = false;
    this.dsky.nounFlash = false;
    this.dsky.setDisplay({
      prog: '00', verb: '00', noun: '00',
      r1: '+00000', r2: '+00000', r3: '+00000',
      lights: {
        OPR_ERR: false, RESTART: false, KEY_REL: false, TRACKER: false,
        ALT: false, VEL: false, PROG: false, TEMP: false,
        GIMBAL_LOCK: false, NO_ATT: false, UPLINK_ACTY: false,
      },
    });
  }

  // -------------------------------------------------------------------------
  // OPR ERR — invalid entry
  // -------------------------------------------------------------------------
  _operError() {
    this.state       = 'IDLE';
    this.verbBuf     = '';
    this.nounBuf     = '';
    this.pendingVerb = null;
    this.dsky.verbFlash = false;
    this.dsky.nounFlash = false;
    this.dsky.setDisplay({ lights: { OPR_ERR: true } });
  }

  // -------------------------------------------------------------------------
  // RSET during entry — abort input, restore last committed values
  // -------------------------------------------------------------------------
  _reset() {
    this.state       = 'IDLE';
    this.verbBuf     = '';
    this.nounBuf     = '';
    this.pendingVerb = null;
    this.proAction   = null;
    this.dsky.verbFlash = false;
    this.dsky.nounFlash = false;
    this.dsky.setDisplay({
      verb: this.activeVerb,
      noun: this.activeNoun,
      lights: { OPR_ERR: false, RESTART: false, KEY_REL: false },
    });
  }

  // -------------------------------------------------------------------------
  // Update register unit labels in the DOM for the locked noun
  // -------------------------------------------------------------------------
  _updateRegLabels(noun) {
    const meta = NOUN_META[noun];
    if (!meta) return;
    const labels = [meta.r1, meta.r2, meta.r3];
    ['r1','r2','r3'].forEach((id, i) => {
      const el = document.querySelector(`#reg-${id} .reg-unit-label`);
      if (el) el.textContent = labels[i];
    });
  }

  // -------------------------------------------------------------------------
  // Called by MissionSimulator when phase changes (auto mode)
  // Syncs active state without user control
  // -------------------------------------------------------------------------
  syncPhase(verb, noun, prog) {
    if (this.userControlled) return;
    this.activeVerb = verb;
    this.activeNoun = noun;
    this.activeProg = prog;
  }

  // -------------------------------------------------------------------------
  // Return noun metadata for a given noun number
  // -------------------------------------------------------------------------
  static nounMeta(noun) {
    return NOUN_META[noun] || { r1: '—', r2: '—', r3: '—' };
  }
}

if (typeof module !== 'undefined') module.exports = { Pinball, NOUN_META };
else window.Pinball = Pinball;
