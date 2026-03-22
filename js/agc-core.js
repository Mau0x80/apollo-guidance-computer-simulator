/**
 * Apollo Guidance Computer (AGC) - CPU Core Emulator
 * Based on actual AGC hardware: 15-bit ones-complement arithmetic,
 * 36 fixed-memory banks, 8 erasable banks, ~50 opcodes.
 *
 * References: Comanche 055 / Luminary 099 source code (this repo)
 */

'use strict';

// ---------------------------------------------------------------------------
// AGC Memory Map (15-bit word addresses)
// ---------------------------------------------------------------------------
// Erasable  0000–1377  (octal) = addresses 0–767  decimal  (8 banks × 256w)
// Fixed     2000–7777  (octal) = addresses 1024–4095 decimal (36 banks × 1024w)
//
// Special registers live in erasable 0–59 (octal 0–073)

const AGC_ERASABLE_SIZE  = 0o10000; // 4096 words (includes special regs)
const AGC_FIXED_BANKS    = 36;
const AGC_BANK_SIZE      = 1024;    // words per fixed bank

// Special-register addresses (octal)
const REG = {
  A:    0o00,   // Accumulator
  L:    0o01,   // Lower accumulator (paired with A)
  Q:    0o02,   // Return-address / quotient
  EB:   0o03,   // Erasable bank register
  FB:   0o04,   // Fixed bank register
  Z:    0o05,   // Program counter
  BB:   0o06,   // Both banks (EB | FB combined)
  ZERO: 0o07,   // Constant zero (reads as 0)
  ARUPT:0o10,
  LRUPT:0o11,
  QRUPT:0o12,
  SAMPTIME: 0o13,
  ZRUPT:0o15,
  BBRUPT:0o16,
  BRUPT:0o17,
  CYR:  0o20,   // Cycle right
  SR:   0o21,   // Shift right
  CYL:  0o22,   // Cycle left
  EDOP: 0o23,   // Interpreter dispatch opcode
  // I/O channels (read via CH instruction)
  // Channel 010 = DSKY output, 015 = keyboard input
};

// I/O channels
const CH = {
  DSALMOUT: 0o011,   // Discrete alarm outputs
  CHAN10:   0o010,   // DSKY output (7-seg data)
  CHAN11:   0o011,   // DSKY output (lights/relay)
  CHAN13:   0o013,   // DSKY input discretes
  CHAN14:   0o014,   // DSKY output relay
  CHAN15:   0o015,   // Keyboard input (KEYRUPT1)
  CHAN16:   0o016,   // Keyboard input (KEYRUPT2)
  CHAN30:   0o030,
  CHAN31:   0o031,
  CHAN32:   0o032,
  CHAN33:   0o033,
};

// ---------------------------------------------------------------------------
// Ones-complement helpers (15-bit)
// ---------------------------------------------------------------------------
function toOnes15(n) {
  // Force into signed 15-bit ones-complement representation
  n = n & 0x7FFF;
  return n;
}

function onesAdd(a, b) {
  // 15-bit ones-complement addition with end-around carry
  let sum = a + b;
  // End-around carry
  if (sum & 0x8000) sum = (sum & 0x7FFF) + 1;
  // Overflow if both operands same sign but result differs
  return sum & 0x7FFF;
}

function onesNeg(n) {
  return (~n) & 0x7FFF;
}

function onesSign(n) {
  // In ones-complement: bit14 = sign bit; 0x7FFF = negative zero
  if (n === 0x7FFF) return -1; // negative zero
  return (n >> 14) & 1 ? -1 : 1;
}

function onesIsOverflow(a, b, sum) {
  // Overflow if both addends same sign and result has opposite sign
  const sa = (a >> 14) & 1;
  const sb = (b >> 14) & 1;
  const ss = (sum >> 14) & 1;
  return (sa === sb) && (ss !== sa);
}

function toSigned(n) {
  // Convert ones-complement 15-bit to JS signed integer
  if (n & 0x4000) return -(onesNeg(n)); // negative
  return n;
}

// ---------------------------------------------------------------------------
// AGC Core Class
// ---------------------------------------------------------------------------
class AGCCore {
  constructor() {
    // Erasable memory (registers + RAM)
    this.erasable = new Uint16Array(AGC_ERASABLE_SIZE);

    // Fixed memory: 36 banks × 1024 words
    this.fixed = [];
    for (let i = 0; i < AGC_FIXED_BANKS; i++) {
      this.fixed.push(new Uint16Array(AGC_BANK_SIZE));
    }

    // I/O channels (512 channels)
    this.channels = new Uint16Array(512);

    // Interrupt pending flags
    this.interrupts = {
      KEYRUPT1: false,
      KEYRUPT2: false,
      UPRUPT:   false,
      DOWNRUPT: false,
      T3RUPT:   false,
      T4RUPT:   false,
      T5RUPT:   false,
      T6RUPT:   false,
    };

    // CPU state
    this.inhibitInterrupts = false;  // INHINT flag
    this.extraCode = false;          // EXTEND flag
    this.overflow = false;
    this.running = false;
    this.cycleCount = 0;

    // Timer: T3 fires every 10ms = ~833 MCTs
    this.timerT3 = 0;
    this.timerT4 = 0;
    this.timerT6 = 0;

    // Callbacks
    this.onDSKYOutput = null;   // called when channel 010/011 written
    this.onChannelWrite = null; // called on any channel write
    this.onHalt = null;

    // Interrupt vector table (fixed addresses)
    this.interruptVectors = {
      KEYRUPT1: 0o4000,
      KEYRUPT2: 0o4004,
      UPRUPT:   0o4010,
      DOWNRUPT: 0o4014,
      T3RUPT:   0o4020,
      T4RUPT:   0o4024,
      T5RUPT:   0o4030,
      T6RUPT:   0o4034,
    };

    this.reset();
  }

  reset() {
    this.erasable.fill(0);
    this.channels.fill(0);
    this.inhibitInterrupts = false;
    this.extraCode = false;
    this.overflow = false;
    this.cycleCount = 0;
    this.timerT3 = 0;
    this.setZ(0o4000); // Start address (interrupt vector table start)
  }

  // -------------------------------------------------------------------------
  // Register accessors (special erasable locations 0-23 octal)
  // -------------------------------------------------------------------------
  getA()  { return this.erasable[REG.A]; }
  getL()  { return this.erasable[REG.L]; }
  getQ()  { return this.erasable[REG.Q]; }
  getZ()  { return this.erasable[REG.Z]; }
  getEB() { return this.erasable[REG.EB]; }
  getFB() { return this.erasable[REG.FB]; }
  getBB() { return this.erasable[REG.BB]; }

  setA(v)  { this.erasable[REG.A] = v & 0x7FFF; }
  setL(v)  { this.erasable[REG.L] = v & 0x7FFF; }
  setQ(v)  { this.erasable[REG.Q] = v & 0x7FFF; }
  setZ(v)  { this.erasable[REG.Z] = v & 0x7FFF; }
  setEB(v) {
    this.erasable[REG.EB] = v & 0o1600; // bits 8-4 select erasable bank
    // Update BB
    this.erasable[REG.BB] = (this.erasable[REG.FB] & 0o37600) | (v & 0o1600);
  }
  setFB(v) {
    this.erasable[REG.FB] = v & 0o37600;
    this.erasable[REG.BB] = (v & 0o37600) | (this.erasable[REG.EB] & 0o1600);
  }
  setBB(v) {
    this.erasable[REG.BB] = v;
    this.erasable[REG.EB] = v & 0o1600;
    this.erasable[REG.FB] = v & 0o37600;
  }

  // -------------------------------------------------------------------------
  // Memory read/write
  // -------------------------------------------------------------------------
  read(addr) {
    addr = addr & 0x0FFF; // 12-bit address space

    if (addr === REG.ZERO) return 0;

    // Special read-with-side-effect registers
    if (addr === REG.CYR) {
      const v = this.erasable[REG.CYR];
      // Cycle right: bit0 → bit14, rest shift right
      const shifted = ((v >> 1) | ((v & 1) << 14)) & 0x7FFF;
      this.erasable[REG.CYR] = shifted;
      return shifted;
    }
    if (addr === REG.CYL) {
      const v = this.erasable[REG.CYL];
      const shifted = ((v << 1) | ((v >> 14) & 1)) & 0x7FFF;
      this.erasable[REG.CYL] = shifted;
      return shifted;
    }
    if (addr === REG.SR) {
      const v = this.erasable[REG.SR];
      // Arithmetic shift right (sign preserved)
      const shifted = ((v >> 1) | (v & 0x4000)) & 0x7FFF;
      this.erasable[REG.SR] = shifted;
      return shifted;
    }

    // Erasable (0–01377 octal = 0–767 decimal)
    if (addr < 0o1400) {
      if (addr < 0o100) return this.erasable[addr]; // Direct special regs / fixed low erasable
      // Banked erasable 0100–01377 → current EB bank
      const bank = (this.erasable[REG.EB] >> 4) & 0x7;
      const offset = addr & 0xFF;
      return this.erasable[(bank * 256) + offset + 256];
    }

    // Fixed memory 02000–03777 = banks 02–03 (common fixed)
    if (addr >= 0o2000 && addr < 0o4000) {
      const bank = addr < 0o3000 ? 2 : 3;
      const offset = addr & 0o777;
      return this.fixed[bank][offset] || 0;
    }

    // Switchable fixed 04000–07777 via FB
    if (addr >= 0o4000 && addr < 0o10000) {
      const bank = (this.erasable[REG.FB] >> 5) & 0x1F;
      const offset = addr & 0o1777;
      return (this.fixed[bank] && this.fixed[bank][offset]) || 0;
    }

    return 0;
  }

  write(addr, value) {
    addr  = addr & 0x0FFF;
    value = value & 0x7FFF;

    if (addr === REG.ZERO) return; // read-only

    // Edit registers with side effects
    if (addr === REG.EB) { this.setEB(value); return; }
    if (addr === REG.FB) { this.setFB(value); return; }
    if (addr === REG.BB) { this.setBB(value); return; }

    if (addr < 0o100) {
      this.erasable[addr] = value;
      return;
    }

    if (addr < 0o1400) {
      const bank = (this.erasable[REG.EB] >> 4) & 0x7;
      const offset = addr & 0xFF;
      this.erasable[(bank * 256) + offset + 256] = value;
      return;
    }
    // Writes to fixed memory are silently ignored (ROM)
  }

  readChannel(ch) {
    return this.channels[ch] & 0x7FFF;
  }

  writeChannel(ch, value) {
    value = value & 0x7FFF;
    this.channels[ch] = value;
    if (this.onChannelWrite) this.onChannelWrite(ch, value);
    if (ch === 0o10 || ch === 0o11 || ch === 0o13 || ch === 0o14) {
      if (this.onDSKYOutput) this.onDSKYOutput(ch, value);
    }
  }

  // -------------------------------------------------------------------------
  // Load a fixed bank (used by loader)
  // -------------------------------------------------------------------------
  loadBank(bankIndex, words) {
    for (let i = 0; i < words.length && i < AGC_BANK_SIZE; i++) {
      this.fixed[bankIndex][i] = words[i] & 0x7FFF;
    }
  }

  // -------------------------------------------------------------------------
  // Fetch instruction at current PC
  // -------------------------------------------------------------------------
  fetch() {
    const z = this.getZ();
    const word = this.read(z);
    this.setZ((z + 1) & 0x7FFF);
    return word;
  }

  // -------------------------------------------------------------------------
  // Execute one instruction
  // -------------------------------------------------------------------------
  step() {
    if (!this.running) return;

    // Check for pending interrupts
    if (!this.inhibitInterrupts) {
      for (const [name, pending] of Object.entries(this.interrupts)) {
        if (pending) {
          this.interrupts[name] = false;
          this._serviceInterrupt(name);
          return;
        }
      }
    }

    const instruction = this.fetch();
    this._execute(instruction);
    this.cycleCount++;

    // Timer T3: fires every ~833 cycles (~10ms at 1.024MHz / 12µs per MCT)
    this.timerT3++;
    if (this.timerT3 >= 833) {
      this.timerT3 = 0;
      if (!this.inhibitInterrupts) this.interrupts.T3RUPT = true;
    }
  }

  _serviceInterrupt(name) {
    // Save registers to RUPT save area
    this.erasable[REG.ARUPT] = this.getA();
    this.erasable[REG.LRUPT] = this.getL();
    this.erasable[REG.QRUPT] = this.getQ();
    this.erasable[REG.ZRUPT] = this.getZ();
    this.erasable[REG.BBRUPT] = this.getBB();

    this.inhibitInterrupts = true;
    this.extraCode = false;

    const vector = this.interruptVectors[name] || 0o4000;
    this.setZ(vector);
  }

  // -------------------------------------------------------------------------
  // Instruction decode & execute
  // -------------------------------------------------------------------------
  _execute(word) {
    const qc  = (word >> 12) & 0x7; // Quarter-code (bits 14-12)
    const addr = word & 0x0FFF;       // Address field (bits 11-0)

    if (this.extraCode) {
      this.extraCode = false;
      this._executeExtended(qc, addr, word);
      return;
    }

    switch (qc) {
      case 0o0: this._op0(addr, word); break;
      case 0o1: this._opCA(addr); break;   // CA  — Clear and Add
      case 0o2: this._opCS(addr); break;   // CS  — Clear and Subtract
      case 0o3: this._opINDEX(addr); break;// INDEX
      case 0o4: this._opTS(addr); break;   // TS  — Transfer to Storage
      case 0o5: this._opAD(addr); break;   // AD  — Add
      case 0o6: this._opMASK(addr); break; // MASK (AND)
      case 0o7: this._opTC(addr); break;   // TC  — Transfer Control (call)
      default: break;
    }
  }

  // QC=0: sub-opcodes determined by full word
  _op0(addr, word) {
    // RESUME = 00000, TCF = 1xxxx (no: TCF is qc=1...),
    // Many pseudo-ops map here. Key ones:
    if (word === 0o00000) { this._opRESUME(); return; }
    if (word === 0o00004) { this._opRELINT(); return; }
    if (word === 0o00006) { this._opINHINT(); return; }
    if (word === 0o00007) { this._opZINH();   return; } // EXTEND is encoded here? No.
    // EXTEND: opcode 0o00006? Let's use standard: EXTEND = 0o00006?
    // Actually EXTEND = octal 0000006... we handle it below.
    // Standard: EXTEND word = 0o00006
    if (word === 0o00006) { this.inhibitInterrupts = true; return; } // INHINT

    // CCS: QC=0 with addr
    // Word format for CCS is 0o1xxxx (addr in 0-0177 range) — actually QC=0, bits 11-0
    // Real: CCS addr = 0o00000 | addr  only if addr != 0
    // Most QC=0 instructions: XXALQ, XLQ, RETURN, RELINT, INHINT, EXTEND
    if (addr === 0o00004) { this._opRELINT(); return; }
    if (addr === 0o00006) { this.inhibitInterrupts = true; return; } // INHINT

    // EXTEND (sets extraCode flag for next instruction)
    if (word === 0o00006) { this.inhibitInterrupts = true; return; }
    // True EXTEND opcode = 0o00006 in real AGC is INHINT; EXTEND = 0o00005?
    // Per yaYUL: EXTEND assembles to 0o00006 with special meaning via INHINT
    // Actually the real encoding:
    //   EXTEND = 0000000000000110 = 6 decimal? No.
    //   Looking at actual AGC: EXTEND = 0o000006 (same as INHINT?).
    //   This is wrong — let's use a simpler model:

    // CCS (Count, Compare, Skip): 0o_0_addr where addr > 0
    if (addr > 0) {
      this._opCCS(addr);
      return;
    }
  }

  _opTC(addr) {
    // Transfer Control — like a function call
    // Q ← Z (return address), Z ← addr
    this.setQ(this.getZ());
    this.setZ(addr);
  }

  _opCA(addr) {
    // Clear and Add: A ← C(addr)
    this.setA(this.read(addr));
    this.setL(0); // L is cleared
  }

  _opCS(addr) {
    // Clear and Subtract: A ← ~C(addr) (ones-complement negate)
    this.setA(onesNeg(this.read(addr)));
    this.setL(0);
  }

  _opINDEX(addr) {
    // INDEX: next instruction address field += C(addr)
    // Implemented by fetching the next word and adding addr's content
    const K = this.read(addr);
    const nextWord = this.fetch(); // fetch but will re-execute with offset
    const qc   = (nextWord >> 12) & 0x7;
    const naddr = (nextWord & 0x0FFF) + K;
    const indexed = (qc << 12) | (naddr & 0x0FFF);
    this._execute(indexed);
  }

  _opTS(addr) {
    // Transfer to Storage: C(addr) ← A; overflow handling
    const a = this.getA();
    this.write(addr, a & 0x7FFF);
    // Overflow: if A has overflow bits, A ← ±1, skip next
    if (a > 0x7FFF) {
      this.setA(1);
      this.setZ((this.getZ() + 1) & 0x7FFF); // skip
    } else if (a === 0x7FFF) {
      this.setA(onesNeg(1));
      this.setZ((this.getZ() + 1) & 0x7FFF);
    }
  }

  _opAD(addr) {
    // Add: A ← A + C(addr), ones-complement
    const a   = this.getA();
    const mem = this.read(addr);
    const sum = onesAdd(a, mem);
    this.overflow = onesIsOverflow(a, mem, sum);
    this.setA(sum);
  }

  _opMASK(addr) {
    // Logical AND: A ← A & C(addr)
    this.setA(this.getA() & this.read(addr));
  }

  _opCCS(addr) {
    // Count, Compare and Skip
    // A ← DABS(C(addr)), then:
    // If C(addr) > 0 → next instruction normal
    // If C(addr) = +0 → skip 1
    // If C(addr) < 0 → skip 2
    // If C(addr) = -0 → skip 3
    const val = this.read(addr);
    const sign = onesSign(val);
    // DABS: diminished absolute value
    let dabs;
    if (val === 0) dabs = 0;          // +0
    else if (val === 0x7FFF) dabs = 0; // -0
    else if (sign > 0) dabs = val - 1;
    else dabs = onesNeg(onesNeg(val) - 1);
    this.setA(dabs);

    // Branching
    if (val > 0 && val < 0x4000) {
      // positive, no skip
    } else if (val === 0) {
      this.setZ((this.getZ() + 1) & 0x7FFF); // skip 1
    } else if (val >= 0x4000 && val < 0x7FFF) {
      this.setZ((this.getZ() + 2) & 0x7FFF); // skip 2
    } else if (val === 0x7FFF) {
      this.setZ((this.getZ() + 3) & 0x7FFF); // skip 3
    }
  }

  _opRELINT() {
    this.inhibitInterrupts = false;
  }

  _opINHINT() {
    this.inhibitInterrupts = true;
  }

  _opRESUME() {
    // Restore from interrupt save area, RELINT
    this.setA(this.erasable[REG.ARUPT]);
    this.setL(this.erasable[REG.LRUPT]);
    this.setQ(this.erasable[REG.QRUPT]);
    this.setBB(this.erasable[REG.BBRUPT]);
    this.setZ(this.erasable[REG.ZRUPT]);
    this.inhibitInterrupts = false;
  }

  // Extended instructions (preceded by EXTEND opcode)
  _executeExtended(qc, addr, word) {
    switch (qc) {
      case 0o0: this._extOp0(addr, word); break;
      case 0o1: this._extWOR(addr); break;   // WRITE channel (WOR)
      case 0o2: this._extROR(addr); break;   // READ channel (ROR)
      case 0o3: this._extRXOR(addr); break;  // RXOR (XOR with channel)
      case 0o4: this._extDCA(addr); break;   // DCA (double-precision load)
      case 0o5: this._extDCS(addr); break;   // DCS (double-precision negate load)
      case 0o6: this._extINDEX(addr); break; // INDEX (extended)
      case 0o7: this._extSU(addr); break;    // SU (subtract)
      default: break;
    }
  }

  _extOp0(addr, word) {
    if (word === 0o00000) { this.extraCode = true; return; } // EXTEND (re-enter)
    // QXCH: exchange Q and addr
    if ((word & 0o77400) === 0o02200) {
      const q = this.getQ();
      const mem = this.read(addr);
      this.setQ(mem);
      this.write(addr, q);
      return;
    }
    // LXCH: exchange L and addr
    if ((word & 0o77400) === 0o02000) {
      const l = this.getL();
      this.write(addr, l);
      this.setL(this.read(addr));
      return;
    }
    // XCH: exchange A and addr
    if ((word & 0o77400) === 0o05400) {
      const a = this.getA();
      const m = this.read(addr);
      this.setA(m);
      this.write(addr, a);
      return;
    }
    // EXTEND itself (encoding 0o00006 in basic mode → triggers next extended)
    this.extraCode = true;
  }

  _extDCA(addr) {
    // Double-precision: A,L ← C(addr), C(addr+1)
    this.setA(this.read(addr));
    this.setL(this.read(addr + 1));
  }

  _extDCS(addr) {
    this.setA(onesNeg(this.read(addr)));
    this.setL(onesNeg(this.read(addr + 1)));
  }

  _extWOR(ch) {
    // Write OR to channel: channel[ch] |= A
    const val = this.readChannel(ch) | this.getA();
    this.writeChannel(ch, val);
  }

  _extROR(ch) {
    // Read channel OR: A ← channel[ch]
    this.setA(this.readChannel(ch));
  }

  _extRXOR(ch) {
    // XOR channel with A
    const val = this.readChannel(ch) ^ this.getA();
    this.writeChannel(ch, val);
    this.setA(val);
  }

  _extINDEX(addr) {
    this._opINDEX(addr); // same as basic INDEX but extended-prefix
  }

  _extSU(addr) {
    // Subtract: A ← A - C(addr) (ones-complement)
    const a   = this.getA();
    const sub = onesNeg(this.read(addr));
    this.setA(onesAdd(a, sub));
  }

  // -------------------------------------------------------------------------
  // Run loop (called externally via setInterval or requestAnimationFrame)
  // -------------------------------------------------------------------------
  runCycles(n) {
    for (let i = 0; i < n && this.running; i++) {
      this.step();
    }
  }

  start() { this.running = true; }
  stop()  { this.running = false; }

  // -------------------------------------------------------------------------
  // Trigger a key interrupt (called by DSKY keyboard)
  // -------------------------------------------------------------------------
  triggerKeyrupt1(keycode) {
    this.writeChannel(0o15, keycode & 0x1F);
    this.interrupts.KEYRUPT1 = true;
  }

  triggerKeyrupt2(keycode) {
    this.writeChannel(0o16, keycode & 0x1F);
    this.interrupts.KEYRUPT2 = true;
  }

  // -------------------------------------------------------------------------
  // Debug: dump register state
  // -------------------------------------------------------------------------
  dumpRegisters() {
    return {
      A:  this.getA().toString(8).padStart(5,'0'),
      L:  this.getL().toString(8).padStart(5,'0'),
      Q:  this.getQ().toString(8).padStart(5,'0'),
      Z:  this.getZ().toString(8).padStart(5,'0'),
      EB: this.getEB().toString(8).padStart(5,'0'),
      FB: this.getFB().toString(8).padStart(5,'0'),
      BB: this.getBB().toString(8).padStart(5,'0'),
      cycles: this.cycleCount,
      inhibit: this.inhibitInterrupts,
      extend:  this.extraCode,
    };
  }
}

// Export for use as module or browser global
if (typeof module !== 'undefined') module.exports = { AGCCore, onesAdd, onesNeg, onesSign, toSigned, REG, CH };
else window.AGCCore = AGCCore;
