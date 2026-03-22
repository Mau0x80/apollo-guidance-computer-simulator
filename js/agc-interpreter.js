/**
 * AGC Interpretive Language Engine
 *
 * The AGC has a second-level "interpreted" instruction set running on top
 * of the basic machine code (see INTERPRETER.agc — 77 KB).
 * Interpretive ops are 8-bit opcodes packed two-per-word, supporting:
 *   - Double-precision scalar arithmetic (DLOAD, DSTORE, DSU, DMP, DDIV)
 *   - Vector arithmetic (VLOAD, VADD, VSUB, VXSC, VXV, UNIT, ABVAL)
 *   - Matrix arithmetic (MXV, VXM)
 *   - Trig / transcendental (SINE, COSINE, ARCTAN, SQRT)
 *   - Control (CALL, GOTO, RETURN, BON, BMN, BOFZ, BHIZ, EXIT)
 *
 * All values are in "unit" fractional format (1.0 = 0x3FFF in 15-bit).
 * Vectors are 3×DP (6 words), matrices are 3×3×DP (18 words).
 * MPAC (multi-precision accumulator) is 7 words of erasable.
 */

'use strict';

// Scaling: 1.0 in AGC fractional = 2^14 - 1 = 16383
const SCALE = 16383;

function toFloat(agcWord) {
  // Convert signed 15-bit ones-complement integer to float in range [-1, 1]
  const n = agcWord & 0x7FFF;
  if (n >= 0x4000) return -(((~n) & 0x3FFF) / SCALE); // negative
  return n / SCALE;
}

function fromFloat(f) {
  // Convert float [-1,1] back to 15-bit ones-complement
  f = Math.max(-1, Math.min(1, f));
  if (f < 0) return (~Math.round(-f * SCALE)) & 0x7FFF;
  return Math.round(f * SCALE) & 0x7FFF;
}

// DP (double-precision) — two consecutive words, high word first
function dpToFloat(hi, lo) {
  const sign = (hi & 0x4000) ? -1 : 1;
  const hiAbs = hi & 0x3FFF;
  const loAbs = (sign < 0) ? ((~lo) & 0x7FFF) : lo;
  return sign * (hiAbs * SCALE + loAbs) / (SCALE * SCALE);
}

function floatToDP(f) {
  f = Math.max(-1, Math.min(1, f));
  const negative = f < 0;
  f = Math.abs(f);
  const raw = Math.round(f * SCALE * SCALE);
  const hi  = Math.floor(raw / SCALE) & 0x3FFF;
  const lo  = (raw % SCALE) & 0x7FFF;
  if (negative) {
    return { hi: (~hi) & 0x7FFF, lo: (~lo) & 0x7FFF };
  }
  return { hi, lo };
}

// 3-vector helpers
function vecAdd(a, b) { return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]; }
function vecSub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function vecScale(a, s) { return [a[0]*s, a[1]*s, a[2]*s]; }
function vecDot(a, b)  { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function vecCross(a, b) {
  return [
    a[1]*b[2] - a[2]*b[1],
    a[2]*b[0] - a[0]*b[2],
    a[0]*b[1] - a[1]*b[0],
  ];
}
function vecMag(a) { return Math.sqrt(vecDot(a,a)); }
function vecUnit(a) {
  const m = vecMag(a);
  return m > 0 ? vecScale(a, 1/m) : [0,0,0];
}

// -------------------------------------------------------------------------
// Interpreter class
// -------------------------------------------------------------------------
class AGCInterpreter {
  constructor(agc) {
    this.agc = agc;

    // MPAC: multi-precision accumulator (7 words, indices 0-6)
    // MPAC is stored in erasable memory. We track it as JS floats here.
    this.mpac = [0, 0, 0, 0, 0, 0, 0]; // MPAC, MPAC+1..MPAC+6

    // Push-down stack (PUSH/PULL ops)
    this.pdl = new Array(44).fill(0);  // 22 double-precision values
    this.pdlPointer = 0;               // PUSHLOC

    // Mode: 0=scalar, 1=vector, 2=matrix
    this.mode = 0;

    // Current bank / location for interpretive program
    this.loc    = 0;
    this.bankset = 0;
  }

  // -------------------------------------------------------------------------
  // Execute a single interpretive opcode (by name)
  // -------------------------------------------------------------------------
  execute(opName, operand) {
    switch (opName) {
      // --- Scalar load/store ---
      case 'DLOAD':   this._dload(operand); break;
      case 'SLOAD':   this._sload(operand); break;
      case 'DSTORE':  this._dstore(operand); break;
      case 'STODL':   this._stodl(operand); break;
      case 'STORE':   this._store(operand); break;

      // --- Scalar arithmetic ---
      case 'DAD':     this._dad(operand); break;
      case 'DSU':     this._dsu(operand); break;
      case 'DMP':     this._dmp(operand); break;
      case 'DMPR':    this._dmp(operand); break;  // rounded variant
      case 'DDIV':    this._ddiv(operand); break;
      case 'ABVAL':   this._abval(); break;
      case 'ROUND':   this._round(); break;
      case 'DOUBLE':  this._double(); break;
      case 'SIGN':    this._sign(operand); break;

      // --- Transcendental ---
      case 'SQRT':    this._sqrt(); break;
      case 'SINE':    this._sine(); break;
      case 'COSINE':  this._cosine(); break;
      case 'ARCSIN':  this._arcsin(); break;
      case 'ARCCOS':  this._arccos(); break;

      // --- Vector ops ---
      case 'VLOAD':   this._vload(operand); break;
      case 'VADD':    this._vadd(operand); break;
      case 'VSUB':    this._vsub(operand); break;
      case 'VXSC':    this._vxsc(operand); break;  // vector × scalar
      case 'VXV':     this._vxv(operand); break;   // vector × vector (cross)
      case 'DOT':     this._dot(operand); break;
      case 'UNIT':    this._unit(); break;
      case 'ABVAL':   this._abval(); break;
      case 'VCOMP':   this._vcomp(); break;         // complement

      // --- Control ---
      case 'SETPD':   this._setpd(operand); break;
      case 'PUSH':    this._push(); break;
      case 'PDDL':    this._pddl(operand); break;
      case 'PDVL':    this._pdvl(operand); break;
      case 'PULL':    this._pull(); break;
      case 'EXIT':    /* return to basic */  break;
      case 'RVQ':     /* return via Q */     break;
      case 'GOTO':    this._goto(operand); break;
      case 'CALL':    this._call(operand); break;
      case 'RETURN':  break;

      // --- Branches ---
      case 'BMN':     return this._bmn(operand);  // branch if MPAC < 0
      case 'BZE':     return this._bze(operand);  // branch if MPAC = 0
      case 'BHIZ':    return this._bze(operand);
      case 'BON':     this._bon(operand); break;
      case 'BOFZ':    this._bofz(operand); break;

      // --- Normalization ---
      case 'NORM':    this._norm(operand); break;
      case 'UNIT':    this._unit(); break;

      default:
        console.warn(`[INTERP] Unknown opcode: ${opName}`);
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // MPAC access as float
  // -------------------------------------------------------------------------
  _mpacGet()    { return this.mpac[0]; }
  _mpacSet(v)   { this.mpac[0] = v; }
  _mpacGetDP()  { return this.mpac[0]; } // already stored as float
  _mpacSetDP(v) { this.mpac[0] = v; this.mpac[1] = 0; }

  _getVec()  { return [this.mpac[0], this.mpac[1], this.mpac[2]]; }
  _setVec(v) { this.mpac[0]=v[0]; this.mpac[1]=v[1]; this.mpac[2]=v[2]; }

  // -------------------------------------------------------------------------
  // Scalar load/store
  // -------------------------------------------------------------------------
  _dload(addr) {
    // Load double-precision from erasable addr, addr+1
    const hi = this.agc ? this.agc.read(addr)   : 0;
    const lo = this.agc ? this.agc.read(addr+1) : 0;
    this._mpacSetDP(dpToFloat(hi, lo));
    this.mpac[2] = 0;
    this.mode = 0;
  }

  _sload(addr) {
    const val = this.agc ? this.agc.read(addr) : 0;
    this._mpacSetDP(toFloat(val));
    this.mode = 0;
  }

  _dstore(addr) {
    const { hi, lo } = floatToDP(this._mpacGet());
    if (this.agc) { this.agc.write(addr, hi); this.agc.write(addr+1, lo); }
  }

  _stodl(addr) {
    this._dstore(addr);  // store then load next (chained)
  }

  _store(addr) {
    const val = fromFloat(this._mpacGet());
    if (this.agc) this.agc.write(addr, val);
  }

  // -------------------------------------------------------------------------
  // Arithmetic
  // -------------------------------------------------------------------------
  _dad(addr) {
    const hi = this.agc ? this.agc.read(addr)   : 0;
    const lo = this.agc ? this.agc.read(addr+1) : 0;
    this._mpacSetDP(this._mpacGet() + dpToFloat(hi, lo));
  }

  _dsu(addr) {
    const hi = this.agc ? this.agc.read(addr)   : 0;
    const lo = this.agc ? this.agc.read(addr+1) : 0;
    this._mpacSetDP(this._mpacGet() - dpToFloat(hi, lo));
  }

  _dmp(addr) {
    const hi = this.agc ? this.agc.read(addr)   : 0;
    const lo = this.agc ? this.agc.read(addr+1) : 0;
    this._mpacSetDP(this._mpacGet() * dpToFloat(hi, lo));
  }

  _ddiv(addr) {
    const hi = this.agc ? this.agc.read(addr)   : 0;
    const lo = this.agc ? this.agc.read(addr+1) : 0;
    const divisor = dpToFloat(hi, lo);
    this._mpacSetDP(divisor !== 0 ? this._mpacGet() / divisor : 0);
  }

  _abval() {
    if (this.mode === 1) {
      const v = this._getVec();
      this._mpacSetDP(vecMag(v));
      this.mode = 0;
    } else {
      this._mpacSetDP(Math.abs(this._mpacGet()));
    }
  }

  _round() {
    const v = this._mpacGet();
    this._mpacSetDP(Math.round(v * SCALE) / SCALE);
  }

  _double() {
    this._mpacSetDP(this._mpacGet() * 2);
  }

  _sign(addr) {
    const hi = this.agc ? this.agc.read(addr) : 0;
    const s  = (hi & 0x4000) ? -1 : 1;
    const v  = this._mpacGet();
    this._mpacSetDP(s * Math.abs(v));
  }

  // -------------------------------------------------------------------------
  // Transcendental — AGC uses half-angle scaled: 1.0 = 180 degrees
  // -------------------------------------------------------------------------
  _sqrt() {
    this._mpacSetDP(Math.sqrt(Math.max(0, this._mpacGet())));
  }

  _sine() {
    // Input: fraction of full circle (1.0 = 360°)
    this._mpacSetDP(Math.sin(this._mpacGet() * 2 * Math.PI));
  }

  _cosine() {
    this._mpacSetDP(Math.cos(this._mpacGet() * 2 * Math.PI));
  }

  _arcsin() {
    const v = Math.max(-1, Math.min(1, this._mpacGet()));
    this._mpacSetDP(Math.asin(v) / (2 * Math.PI));
  }

  _arccos() {
    const v = Math.max(-1, Math.min(1, this._mpacGet()));
    this._mpacSetDP(Math.acos(v) / (2 * Math.PI));
  }

  // -------------------------------------------------------------------------
  // Vector ops
  // -------------------------------------------------------------------------
  _vload(addr) {
    const x = dpToFloat(this.agc?.read(addr)   || 0, this.agc?.read(addr+1) || 0);
    const y = dpToFloat(this.agc?.read(addr+2) || 0, this.agc?.read(addr+3) || 0);
    const z = dpToFloat(this.agc?.read(addr+4) || 0, this.agc?.read(addr+5) || 0);
    this._setVec([x, y, z]);
    this.mode = 1;
  }

  _vadd(addr) {
    const v2 = this._vecFromAddr(addr);
    this._setVec(vecAdd(this._getVec(), v2));
  }

  _vsub(addr) {
    const v2 = this._vecFromAddr(addr);
    this._setVec(vecSub(this._getVec(), v2));
  }

  _vxsc(addr) {
    // Vector × scalar (scalar from addr as DP)
    const hi = this.agc?.read(addr)   || 0;
    const lo = this.agc?.read(addr+1) || 0;
    const s  = dpToFloat(hi, lo);
    this._setVec(vecScale(this._getVec(), s));
  }

  _vxv(addr) {
    // Cross product
    const v2 = this._vecFromAddr(addr);
    this._setVec(vecCross(this._getVec(), v2));
  }

  _dot(addr) {
    const v2 = this._vecFromAddr(addr);
    const d  = vecDot(this._getVec(), v2);
    this._mpacSetDP(d);
    this.mode = 0;
  }

  _unit() {
    if (this.mode === 1) {
      this._setVec(vecUnit(this._getVec()));
    }
  }

  _vcomp() {
    const v = this._getVec();
    this._setVec([-v[0], -v[1], -v[2]]);
  }

  _vecFromAddr(addr) {
    const x = dpToFloat(this.agc?.read(addr)   || 0, this.agc?.read(addr+1) || 0);
    const y = dpToFloat(this.agc?.read(addr+2) || 0, this.agc?.read(addr+3) || 0);
    const z = dpToFloat(this.agc?.read(addr+4) || 0, this.agc?.read(addr+5) || 0);
    return [x, y, z];
  }

  // -------------------------------------------------------------------------
  // Stack (Push-down list)
  // -------------------------------------------------------------------------
  _setpd(addr) {
    this.pdlPointer = addr & 0xFF;
  }

  _push() {
    this.pdl[this.pdlPointer++] = this._mpacGet();
  }

  _pddl(addr) {
    this._dload(addr);
    this._push();
  }

  _pdvl(addr) {
    this._vload(addr);
    // push vector (3 values)
    const v = this._getVec();
    this.pdl[this.pdlPointer++] = v[0];
    this.pdl[this.pdlPointer++] = v[1];
    this.pdl[this.pdlPointer++] = v[2];
  }

  _pull() {
    if (this.pdlPointer > 0) {
      this._mpacSetDP(this.pdl[--this.pdlPointer]);
    }
  }

  // -------------------------------------------------------------------------
  // Branches — return true if branch taken
  // -------------------------------------------------------------------------
  _bmn(addr) {
    return this._mpacGet() < 0;
  }

  _bze(addr) {
    return Math.abs(this._mpacGet()) < 1e-10;
  }

  _bon(addr) { /* flag-based branch — needs flag system integration */ }
  _bofz(addr) { /* branch if overflow zero */ }

  // -------------------------------------------------------------------------
  // Normalization
  // -------------------------------------------------------------------------
  _norm(addr) {
    // Normalize MPAC, store shift count at addr
    let v = this._mpacGet();
    let shift = 0;
    if (v !== 0) {
      while (Math.abs(v) < 0.5) { v *= 2; shift++; }
      while (Math.abs(v) > 1.0) { v /= 2; shift--; }
    }
    this._mpacSetDP(v);
    if (this.agc) this.agc.write(addr, fromFloat(shift / SCALE));
  }

  _goto(addr)  { if (this.agc) this.agc.setZ(addr); }
  _call(addr)  { if (this.agc) { this.agc.setQ(this.agc.getZ()); this.agc.setZ(addr); } }
}

if (typeof module !== 'undefined') module.exports = { AGCInterpreter, toFloat, fromFloat, dpToFloat, floatToDP };
else window.AGCInterpreter = AGCInterpreter;
