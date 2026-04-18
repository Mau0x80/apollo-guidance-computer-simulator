/**
 * Apollo AGC Simulator — Main Entry Point
 * Wires AGCCore + DSKY + Executive + AGCInterpreter.
 * Includes: mission phase jumper, guided keystroke timeline,
 * accurate GET (Ground Elapsed Time) in seconds for Apollo 11.
 */

'use strict';

// ---------------------------------------------------------------------------
// FLIGHT PHASES — real Apollo 11 GET values (seconds)
// Used for jump buttons and guided timeline activation
// ---------------------------------------------------------------------------
const FLIGHT_PHASES = [
  {
    id: 'prelaunch',
    label: 'Pre-Launch',
    subLabel: 'T−00:00',
    get: 0,
    prog: '00', verb: '06', noun: '36',
    r1: 0, r2: 0, r3: 0,
    lights: { PROG: true },
    desc: 'IMU alignment, checklist, launch commit.',
    r1Label: 'GET (cs)', r2Label: '—', r3Label: '—',
  },
  {
    id: 'liftoff',
    label: 'Lift-Off',
    subLabel: 'T+00:00',
    get: 1,
    prog: '11', verb: '06', noun: '62',
    r1: 0, r2: 0, r3: 6371,
    lights: { PROG: true },
    desc: 'S-IC ignition. AGC enters P11 (Earth Orbit Monitor).',
    r1Label: 'Velocity (fps)', r2Label: 'Alt rate (fps)', r3Label: 'Altitude (nm)',
  },
  {
    id: 'tower',
    label: 'Tower Jettison',
    subLabel: 'T+02:44',
    get: 164,
    prog: '11', verb: '06', noun: '62',
    r1: 9200, r2: 4100, r3: 21,
    lights: {},
    desc: 'LES tower jettisoned. S-IC separation imminent.',
    r1Label: 'Velocity (fps)', r2Label: 'Alt rate (fps)', r3Label: 'Altitude (nm)',
  },
  {
    id: 'seco',
    label: 'SECO / EOI',
    subLabel: 'T+11:49',
    get: 709,
    prog: '11', verb: '06', noun: '62',
    r1: 25567, r2: 1, r3: 100,
    lights: {},
    desc: 'S-IVB cutoff. Earth Orbit Insertion. 100 × 102 nm orbit.',
    r1Label: 'Velocity (fps)', r2Label: 'Alt rate (fps)', r3Label: 'Altitude (nm)',
  },
  {
    id: 'tli',
    label: 'TLI Burn',
    subLabel: 'T+02:44:16',
    get: 9856,
    prog: '15', verb: '06', noun: '44',
    r1: 35580, r2: 219600, r3: 0,
    lights: {},
    desc: 'Trans-Lunar Injection. S-IVB re-ignition, 5 min 47 sec burn.',
    r1Label: 'ΔV required (fps)', r2Label: 'Time of ignition', r3Label: '—',
  },
  {
    id: 'mcc1',
    label: 'Midcourse 1',
    subLabel: 'T+26:44:58',
    get: 96298,
    prog: '30', verb: '06', noun: '33',
    r1: 2.5, r2: 96298, r3: 0,
    lights: {},
    desc: 'First midcourse correction burn (RCS). Refine trajectory.',
    r1Label: 'ΔV (fps)', r2Label: 'Time of ignition', r3Label: '—',
  },
  {
    id: 'loi',
    label: 'Lunar Orbit',
    subLabel: 'T+75:49:50',
    get: 272990,
    prog: '40', verb: '99', noun: '40',
    r1: 0, r2: 0, r3: 0,
    lights: { PROG: true, KEY_REL: true },
    desc: 'LOI: SPS burn puts spacecraft into lunar orbit (60 × 170 nm).',
    r1Label: '—', r2Label: '—', r3Label: '—',
  },
  {
    id: 'undock',
    label: 'LM Undocking',
    subLabel: 'T+100:14:00',
    get: 360840,
    prog: '00', verb: '06', noun: '62',
    r1: 5575, r2: 40, r3: 60,
    lights: {},
    desc: 'Eagle undocks from Columbia. Begins solo flight.',
    r1Label: 'Velocity (fps)', r2Label: 'Alt rate (fps)', r3Label: 'Altitude (nm)',
  },
  {
    id: 'pdi',
    label: 'PDI',
    subLabel: 'T+101:36:14',
    get: 365774,
    prog: '63', verb: '06', noun: '63',
    r1: 14850, r2: 5620, r3: 0,
    lights: { PROG: true },
    desc: 'Powered Descent Initiation. DPS engine ignition. P63 active.',
    r1Label: 'Altitude (ft)', r2Label: 'Velocity (fps)', r3Label: '—',
  },
  {
    id: 'alarm1202',
    label: '1202 Alarm',
    subLabel: 'T+102:33:05',
    get: 369185,
    prog: '64', verb: '06', noun: '64',
    r1: 2400, r2: 183, r3: 150,
    lights: { PROG: true, ALT: true, OPR_ERR: true, RESTART: true },
    desc: 'P64 approach phase. Executive overflow alarm 1202. Press RSET, continue.',
    r1Label: 'Altitude (ft)', r2Label: 'Altitude rate (fps)', r3Label: 'Cross range (ft)',
  },
  {
    id: 'touchdown',
    label: 'Touchdown',
    subLabel: 'T+102:45:40',
    get: 370000,
    prog: '68', verb: '16', noun: '68',
    r1: 0, r2: 0.762, r3: 0,
    lights: { ALT: true, VEL: true },
    desc: 'The Eagle has landed. Sea of Tranquility. P67 / contact light.',
    r1Label: 'Altitude (ft)', r2Label: 'Descent rate (fps)', r3Label: '—',
  },
  {
    id: 'ascent',
    label: 'Ascent',
    subLabel: 'T+124:22:00',
    get: 447720,
    prog: '12', verb: '06', noun: '44',
    r1: 1900, r2: 1600, r3: 18500,
    lights: { PROG: true },
    desc: 'APS ignition. LM ascent to rendezvous orbit.',
    r1Label: 'Velocity (fps)', r2Label: 'Alt rate (fps)', r3Label: 'Altitude (ft)',
  },
  {
    id: 'tei',
    label: 'TEI Burn',
    subLabel: 'T+135:23:42',
    get: 487422,
    prog: '40', verb: '99', noun: '40',
    r1: 0, r2: 0, r3: 0,
    lights: { PROG: true, KEY_REL: true },
    desc: 'Trans-Earth Injection. SPS burns 2:28. Goodbye Moon.',
    r1Label: '—', r2Label: '—', r3Label: '—',
  },
  {
    id: 'entry',
    label: 'Entry',
    subLabel: 'T+194:49:13',
    get: 701353,
    prog: '61', verb: '06', noun: '61',
    r1: 11000, r2: 5.5, r3: -6.5,
    lights: { PROG: true },
    desc: 'CM/SM separation. Entry interface at 400,000 ft. P61 entry prep.',
    r1Label: 'Velocity (fps)', r2Label: 'Gamma (deg)', r3Label: 'Lift vector (deg)',
  },
  {
    id: 'splashdown',
    label: 'Splashdown',
    subLabel: 'T+195:18:35',
    get: 702515,
    prog: '00', verb: '06', noun: '15',
    r1: 0, r2: 0, r3: 0,
    lights: {},
    desc: 'Pacific Ocean recovery. Mission complete. GET 195:18:35.',
    r1Label: '—', r2Label: '—', r3Label: '—',
  },
];

// ---------------------------------------------------------------------------
// KEYSTROKE GUIDE — step-by-step instructions per phase
// Each step: { cue, keys[], purpose, expectedDisplay, autoAfter (seconds) }
// ---------------------------------------------------------------------------
const KEYSTROKE_GUIDE = {
  prelaunch: [
    { cue: 'Verify IMU alignment', keys: ['VERB','1','7','ENTR'], purpose: 'V17: Monitor inertial platform fine alignment (P52)', expectedDisplay: 'V17 N01', autoAfter: null },
    { cue: 'Request GET display', keys: ['VERB','1','6','NOUN','3','6','ENTR'], purpose: 'Monitor Ground Elapsed Time on R1', expectedDisplay: 'V16 N36', autoAfter: null },
    { cue: 'Set program to P00', keys: ['VERB','3','7','NOUN','0','0','ENTR'], purpose: 'V37: Change major mode to P00 (Idle/IMU hold)', expectedDisplay: 'V37 N00', autoAfter: null },
    { cue: 'Confirm PRO to proceed', keys: ['PRO'], purpose: 'Acknowledge program change request', expectedDisplay: '—', autoAfter: null },
    { cue: 'Monitor launch trajectory', keys: ['VERB','0','6','NOUN','6','2','ENTR'], purpose: 'Pre-arm display for orbit insertion data', expectedDisplay: 'V06 N62', autoAfter: null },
  ],
  liftoff: [
    { cue: 'AGC auto-enters P11', keys: [], purpose: 'P11 (Earth Orbit Insert Monitor) triggered automatically at lift-off signal', expectedDisplay: 'P11 V06 N62', autoAfter: 5 },
    { cue: 'Monitor velocity & altitude', keys: ['VERB','0','6','NOUN','6','2','ENTR'], purpose: 'R1=velocity, R2=altitude rate, R3=altitude. Confirm guidance nominal.', expectedDisplay: 'V06 N62', autoAfter: null },
    { cue: 'Watch for MECO cue', keys: [], purpose: 'S-IC cuts off at T+02:41. AGC monitors trajectory. No action needed.', expectedDisplay: '—', autoAfter: 161 },
  ],
  tower: [
    { cue: 'Tower jettison confirmed', keys: [], purpose: 'LES jettisoned automatically at T+02:44. PROG light extinguishes.', expectedDisplay: '—', autoAfter: 3 },
    { cue: 'Verify S-II ignition', keys: ['VERB','0','6','NOUN','6','2','ENTR'], purpose: 'Monitor velocity build-up through S-II burn. R1 should show ~9,200 fps.', expectedDisplay: 'V06 N62', autoAfter: null },
  ],
  seco: [
    { cue: 'SECO — orbit achieved', keys: [], purpose: 'S-IVB shuts down. EOI complete. 100 × 102 nm orbit confirmed.', expectedDisplay: 'P11 active', autoAfter: 4 },
    { cue: 'Display orbital data', keys: ['VERB','0','6','NOUN','6','2','ENTR'], purpose: 'R1=velocity ~25,567 fps, R2=altitude rate ~1 fps, R3=altitude ~100 nm', expectedDisplay: 'V06 N62', autoAfter: null },
    { cue: 'Request perigee/apogee', keys: ['VERB','0','6','NOUN','4','4','ENTR'], purpose: 'N44: Display time of next event. Confirm orbit parameters with MCC.', expectedDisplay: 'V06 N44', autoAfter: null },
    { cue: 'Begin 2-orbit coast check', keys: ['VERB','3','7','NOUN','0','0','ENTR'], purpose: 'Return to P00 for systems checkout during 2-orbit coast before TLI', expectedDisplay: 'V37 N00', autoAfter: null },
    { cue: 'Confirm with PRO', keys: ['PRO'], purpose: 'Proceed to P00 idle mode', expectedDisplay: 'P00', autoAfter: null },
  ],
  tli: [
    { cue: 'Ground uplinks TLI targets', keys: [], purpose: 'Mission Control sends TLI targeting data via uplink (UPLINK ACTY light on)', expectedDisplay: 'UPLINK ACTY', autoAfter: 5 },
    { cue: 'Select P15 TLI monitor', keys: ['VERB','3','7','NOUN','1','5','ENTR'], purpose: 'V37: Change to P15 (TLI Monitor). Displays ignition time and ΔV.', expectedDisplay: 'V37 N15', autoAfter: null },
    { cue: 'Confirm PRO', keys: ['PRO'], purpose: 'Accept TLI program', expectedDisplay: 'P15', autoAfter: null },
    { cue: 'Monitor TLI burn', keys: ['VERB','1','6','NOUN','4','4','ENTR'], purpose: 'V16: Monitor time-to-go. R1=ΔV remaining. Watch for TLI cutoff.', expectedDisplay: 'V16 N44', autoAfter: null },
    { cue: 'Confirm cutoff nominal', keys: ['VERB','0','6','NOUN','4','4','ENTR'], purpose: 'Post-TLI: verify achieved trajectory. ΔV should be ~10,400 fps.', expectedDisplay: 'V06 N44', autoAfter: null },
  ],
  mcc1: [
    { cue: 'Load midcourse targets', keys: ['VERB','3','7','NOUN','3','0','ENTR'], purpose: 'Enter P30 (External ΔV). Ground has sent correction burn data.', expectedDisplay: 'V37 N30', autoAfter: null },
    { cue: 'Confirm PRO', keys: ['PRO'], purpose: 'Proceed into P30', expectedDisplay: 'P30', autoAfter: null },
    { cue: 'Execute RCS burn', keys: ['VERB','9','9','NOUN','4','0','ENTR'], purpose: 'V99: Please perform. Initiates 2.5 fps midcourse correction burn.', expectedDisplay: 'V99 N40', autoAfter: null },
    { cue: 'Confirm burn with PRO', keys: ['PRO'], purpose: 'Accept and execute burn', expectedDisplay: '—', autoAfter: null },
  ],
  loi: [
    { cue: 'Lunar orbit targets uplinked', keys: [], purpose: 'MCC sends LOI targets. UPLINK ACTY flashes.', expectedDisplay: 'UPLINK ACTY', autoAfter: 4 },
    { cue: 'Select P40 SPS burn', keys: ['VERB','3','7','NOUN','4','0','ENTR'], purpose: 'V37: Enter P40 (SPS thrusting). Prepares LOI burn targeting.', expectedDisplay: 'V37 N40', autoAfter: null },
    { cue: 'Confirm PRO', keys: ['PRO'], purpose: 'Commit to LOI burn program', expectedDisplay: 'P40 V99 N40', autoAfter: null },
    { cue: 'Initiate LOI burn', keys: ['PRO'], purpose: 'V99 flashing — press PRO to execute 6-min SPS burn. Slows to orbit.', expectedDisplay: 'LOI active', autoAfter: null },
    { cue: 'Monitor orbit insertion', keys: ['VERB','0','6','NOUN','6','2','ENTR'], purpose: 'Post-LOI: verify 60 × 170 nm lunar orbit achieved.', expectedDisplay: 'V06 N62', autoAfter: null },
  ],
  undock: [
    { cue: 'Activate LM (Eagle)', keys: ['VERB','3','7','NOUN','0','0','ENTR'], purpose: 'CM enters P00. Eagle activates own AGC (Luminary 099).', expectedDisplay: 'P00', autoAfter: null },
    { cue: 'Verify undocking', keys: ['VERB','0','6','NOUN','6','2','ENTR'], purpose: 'Confirm Eagle separation. R3=altitude ~60 nm circular orbit.', expectedDisplay: 'V06 N62', autoAfter: null },
    { cue: 'Eagle: align IMU', keys: ['VERB','4','1','ENTR'], purpose: 'V41: Fine-align IMU to REFSMMAT for descent. Confirmation needed.', expectedDisplay: 'V41', autoAfter: null },
  ],
  pdi: [
    { cue: 'PDI ignition — P63 auto', keys: [], purpose: 'DPS engine ignites. AGC auto-enters P63. Begins 12-min burn.', expectedDisplay: 'P63 V06 N63', autoAfter: 5 },
    { cue: 'Monitor altitude & velocity', keys: ['VERB','1','6','NOUN','6','3','ENTR'], purpose: 'V16 N63: R1=altitude (ft), R2=altitude rate, R3=range to landing site', expectedDisplay: 'V16 N63', autoAfter: null },
    { cue: 'Watch for PITCHOVER', keys: [], purpose: 'At ~7,000 ft AGC pitches LM forward so crew can see the surface.', expectedDisplay: 'P64 incoming', autoAfter: null },
    { cue: 'P64 auto-activates at 7,500 ft', keys: [], purpose: 'AGC transitions P63→P64 (Approach). PROG light on.', expectedDisplay: 'P64 V06 N64', autoAfter: 4 },
  ],
  alarm1202: [
    { cue: '1202 ALARM — PROG light', keys: [], purpose: 'Executive overflow: too many tasks queued. AGC restarts and recovers automatically.', expectedDisplay: 'OPR ERR ON', autoAfter: 2 },
    { cue: 'Press RSET to clear alarm', keys: ['RSET'], purpose: 'RSET resets OPR ERR light. MCC: "We\'re GO on that alarm." Continue descent.', expectedDisplay: 'OPR ERR OFF', autoAfter: null },
    { cue: 'Resume approach monitoring', keys: ['VERB','1','6','NOUN','6','4','ENTR'], purpose: 'V16 N64: Monitor altitude / approach. ALDRIN calls out altitude manually.', expectedDisplay: 'V16 N64', autoAfter: null },
    { cue: '1202 fires again (×3 total)', keys: ['RSET'], purpose: 'Same alarm. MCC GO again. 400 ft. Armstrong takes manual control (P66).', expectedDisplay: '—', autoAfter: null },
    { cue: 'Switch to P66 manual rate', keys: ['VERB','3','7','NOUN','6','6','ENTR'], purpose: 'P66: Armstrong controls descent rate manually. 40 ft / 30 ft.', expectedDisplay: 'V37 N66', autoAfter: null },
    { cue: 'Confirm PRO', keys: ['PRO'], purpose: 'Execute P66 rate-of-descent mode', expectedDisplay: 'P66 active', autoAfter: null },
  ],
  touchdown: [
    { cue: 'Contact light', keys: [], purpose: '"Contact light!" — Probe touches surface. 102:45:40 GET.', expectedDisplay: 'P68', autoAfter: 3 },
    { cue: 'Engine off', keys: ['VERB','3','7','NOUN','0','0','ENTR'], purpose: '"ENGINE ARM — OFF." Return to P00. "The Eagle has landed."', expectedDisplay: 'P00', autoAfter: null },
    { cue: 'Confirm PRO', keys: ['PRO'], purpose: 'Acknowledge engine shutdown, enter surface mode', expectedDisplay: 'P00', autoAfter: null },
    { cue: 'Monitor surface data', keys: ['VERB','1','6','NOUN','6','8','ENTR'], purpose: 'V16 N68: Display landing radar data / surface status', expectedDisplay: 'V16 N68', autoAfter: null },
    { cue: 'Begin stay/no-stay check', keys: ['VERB','0','6','NOUN','0','5','ENTR'], purpose: 'V06 N05: Display abort constants. MCC evaluates abort possibility.', expectedDisplay: 'V06 N05', autoAfter: null },
  ],
  ascent: [
    { cue: 'APS pre-arm', keys: ['VERB','3','7','NOUN','1','2','ENTR'], purpose: 'V37: Select P12 (Ascent program). Computes ascent trajectory.', expectedDisplay: 'V37 N12', autoAfter: null },
    { cue: 'Confirm PRO', keys: ['PRO'], purpose: 'Commit to P12', expectedDisplay: 'P12', autoAfter: null },
    { cue: 'Initiate ascent burn', keys: ['VERB','9','9','NOUN','1','2','ENTR'], purpose: 'V99: Please perform ascent. APS ignition. Stage separation.', expectedDisplay: 'V99 N12', autoAfter: null },
    { cue: 'Confirm PRO', keys: ['PRO'], purpose: 'FIRE. APS ignites. 7:18 burn to orbit.', expectedDisplay: 'P12 active', autoAfter: null },
    { cue: 'Monitor rendezvous', keys: ['VERB','1','6','NOUN','4','4','ENTR'], purpose: 'Track time-to-CSI (concentric sequence initiation). Approach Columbia.', expectedDisplay: 'V16 N44', autoAfter: null },
  ],
  tei: [
    { cue: 'TEI targets uplinked', keys: [], purpose: 'MCC uplinks TEI parameters. UPLINK ACTY light on.', expectedDisplay: 'UPLINK ACTY', autoAfter: 4 },
    { cue: 'Select P40 for SPS burn', keys: ['VERB','3','7','NOUN','4','0','ENTR'], purpose: 'V37: Enter P40. TEI burn: 2 min 28 sec SPS. Escape lunar orbit.', expectedDisplay: 'V37 N40', autoAfter: null },
    { cue: 'Confirm PRO', keys: ['PRO'], purpose: 'Accept TEI program', expectedDisplay: 'P40', autoAfter: null },
    { cue: 'Execute burn', keys: ['PRO'], purpose: 'V99 flashing — PRO to ignite SPS. "Goodbye Moon."', expectedDisplay: 'TEI burn', autoAfter: null },
    { cue: 'Verify trajectory', keys: ['VERB','0','6','NOUN','4','4','ENTR'], purpose: 'Confirm free-return trajectory to Earth re-entry corridor.', expectedDisplay: 'V06 N44', autoAfter: null },
  ],
  entry: [
    { cue: 'CM/SM separation', keys: ['VERB','3','7','NOUN','6','1','ENTR'], purpose: 'V37: Enter P61 (Entry Preparation). Jettison Service Module.', expectedDisplay: 'V37 N61', autoAfter: null },
    { cue: 'Confirm PRO', keys: ['PRO'], purpose: 'Proceed with P61', expectedDisplay: 'P61', autoAfter: null },
    { cue: 'Monitor entry angles', keys: ['VERB','0','6','NOUN','6','1','ENTR'], purpose: 'R2=entry angle (must be −5.5° to −7.2°). R3=lift vector.', expectedDisplay: 'V06 N61', autoAfter: null },
    { cue: 'Entry interface 400,000 ft', keys: [], purpose: 'Blackout begins. AGC automatically manages lift vector for skip correction.', expectedDisplay: '—', autoAfter: 10 },
    { cue: 'Post-blackout confirm', keys: ['VERB','1','6','NOUN','6','4','ENTR'], purpose: 'Monitor drogue deployment altitude and range to recovery ship Hornet.', expectedDisplay: 'V16 N64', autoAfter: null },
  ],
  splashdown: [
    { cue: 'Parachutes deployed', keys: [], purpose: 'Drogues at 24,000 ft, mains at 10,000 ft. Stable 2 (inverted) then righted.', expectedDisplay: '—', autoAfter: 5 },
    { cue: 'Mission complete', keys: ['VERB','3','7','NOUN','0','0','ENTR'], purpose: 'V37 N00: Return to P00. GET 195:18:35. Apollo 11 recovered.', expectedDisplay: 'P00', autoAfter: null },
  ],
};

// ---------------------------------------------------------------------------
// Mission Simulator (drives DSKY display over time)
// ---------------------------------------------------------------------------
class MissionSimulator {
  constructor(dsky) {
    this.dsky = dsky;
    this.alarmFired = {};
  }

  update(simTime, pinball) {
    const phase = this._phaseAtTick(simTime);
    const next  = this._nextPhase(phase);

    // Interpolate sensor data — simTime is a float so this runs smoothly every frame
    const t0 = phase.get;
    const t1 = next ? next.get : t0 + 3600;
    const t  = t1 > t0 ? Math.min(1, (simTime - t0) / (t1 - t0)) : 0;

    const noise = (v) => v !== 0 ? v * (1 + (Math.random() - 0.5) * 0.0008) : 0;

    // 1202 alarm during alarm phase
    if (phase.id === 'alarm1202' && !this.alarmFired['1202'] && Math.random() < 0.002) {
      this.alarmFired['1202'] = true;
      if (window.agcUI) window.agcUI.showAlarm('1202', 'EXECUTIVE OVERFLOW');
      this.dsky.setDisplay({ lights: { OPR_ERR: true, RESTART: true } });
      setTimeout(() => {
        this.dsky.setDisplay({ lights: { OPR_ERR: false, RESTART: false } });
        this.alarmFired['1202'] = false;
      }, 4000);
    }

    if (pinball && pinball.userControlled) {
      // ── USER has taken control via VERB/NOUN entry ──
      // Only update R1/R2/R3 with noun-appropriate telemetry.
      // Verb / Noun / Prog displays are NOT overridden.
      const noun = parseInt(pinball.activeNoun, 10);
      const { r1v, r2v, r3v } = this._dataNoun(noun, phase, t, next, simTime);
      this.dsky.setDisplay({
        r1: this._fmt(noise(r1v)),
        r2: this._fmt(noise(r2v)),
        r3: this._fmt(noise(r3v)),
        lights: { COMP_ACTY: (simTime % 25 < 8) },
      });
      // Keep pinball in sync with the running phase data
      pinball.syncPhase(phase.verb, phase.noun, phase.prog);
    } else {
      // ── AUTO mode — mission simulator drives everything ──
      const r1v = phase.r1 + ((next?.r1 ?? phase.r1) - phase.r1) * t;
      const r2v = phase.r2 + ((next?.r2 ?? phase.r2) - phase.r2) * t;
      const r3v = phase.r3 + ((next?.r3 ?? phase.r3) - phase.r3) * t;

      this.dsky.setDisplay({
        prog:   phase.prog,
        verb:   phase.verb,
        noun:   phase.noun,
        r1:     this._fmt(noise(r1v)),
        r2:     this._fmt(noise(r2v)),
        r3:     this._fmt(noise(r3v)),
        lights: { ...phase.lights, COMP_ACTY: (simTime % 25 < 8) },
      });
      if (pinball) pinball.syncPhase(phase.verb, phase.noun, phase.prog);
    }

    return phase;
  }

  // Map noun → { r1v, r2v, r3v } using current phase telemetry
  _dataNoun(noun, phase, t, next, simTime) {
    const lerp = (a, b) => a + ((b ?? a) - a) * t;
    const r1 = lerp(phase.r1, next?.r1);
    const r2 = lerp(phase.r2, next?.r2);
    const r3 = lerp(phase.r3, next?.r3);

    switch (noun) {
      case  9: return { r1v: 1202,      r2v: 0,   r3v: 0  };   // alarm code
      case 36: return { r1v: simTime * 100, r2v: 0, r3v: 0 };   // GET in csec
      case 42: return { r1v: r3 * 1.1,  r2v: r3 * 0.9, r3v: 0  }; // apogee/perigee approx
      case 43: return { r1v: r3,         r2v: r2,       r3v: 0  }; // alt / alt-rate
      case 44: return { r1v: r1,         r2v: 0,        r3v: 0  }; // time of event
      case 59: return { r1v: r2,         r2v: r3,       r3v: 0  }; // alt rate / alt
      case 61: return { r1v: r1,         r2v: r2,       r3v: r3 }; // entry
      case 62: return { r1v: r1,         r2v: r2,       r3v: r3 }; // orbital
      case 63: return { r1v: r1,         r2v: r2,       r3v: r3 }; // PDI
      case 64: return { r1v: r1,         r2v: r2,       r3v: r3 }; // approach
      case 68: return { r1v: r1,         r2v: r2,       r3v: 0  }; // landing radar
      default: return { r1v: r1,         r2v: r2,       r3v: r3 };
    }
  }

  _phaseAtTick(simTime) {
    let p = FLIGHT_PHASES[0];
    for (const phase of FLIGHT_PHASES) {
      if (phase.get <= simTime) p = phase;
      else break;
    }
    return p;
  }

  _nextPhase(current) {
    const idx = FLIGHT_PHASES.indexOf(current);
    return FLIGHT_PHASES[idx + 1] || null;
  }

  _fmt(val) {
    const sign = val < 0 ? '-' : '+';
    const abs  = Math.abs(val);
    let digits;
    if      (abs >= 99999) digits = '99999';
    else if (abs >= 1000)  digits = Math.round(abs).toString().padStart(5, '0').slice(-5);
    else if (abs >= 10)    digits = abs.toFixed(1).replace('.', '').padStart(5, '0').slice(-5);
    else                   digits = abs.toFixed(3).replace('.', '').slice(0, 5).padStart(5, '0');
    return sign + digits;
  }
}

// ---------------------------------------------------------------------------
// Guided Keystroke Tracker
// ---------------------------------------------------------------------------
class GuideTracker {
  constructor() {
    this.currentPhaseId = 'prelaunch';
    this.currentStep    = 0;
    this.stepDone       = {};   // { 'phaseId:stepIdx': true }
    this.autoTimers     = {};
  }

  setPhase(phaseId) {
    this.currentPhaseId = phaseId;
    this.currentStep    = 0;
    this._cancelAutoTimers();
    this._render();
    this._scheduleAuto();
  }

  steps() {
    return KEYSTROKE_GUIDE[this.currentPhaseId] || [];
  }

  advance() {
    const steps = this.steps();
    if (this.currentStep < steps.length - 1) {
      const key = `${this.currentPhaseId}:${this.currentStep}`;
      this.stepDone[key] = true;
      this.currentStep++;
      this._cancelAutoTimers();
      this._render();
      this._scheduleAuto();
    }
  }

  markDone() {
    const key = `${this.currentPhaseId}:${this.currentStep}`;
    this.stepDone[key] = true;
    this._render();
  }

  isDone(stepIdx) {
    return !!this.stepDone[`${this.currentPhaseId}:${stepIdx}`];
  }

  _scheduleAuto() {
    const step = this.steps()[this.currentStep];
    if (!step || step.autoAfter === null || step.autoAfter === undefined) return;
    const timer = setTimeout(() => {
      this.advance();
    }, step.autoAfter * 1000 / (window.agcUI?.simSpeed || 30));
    this.autoTimers[this.currentStep] = timer;
  }

  _cancelAutoTimers() {
    for (const t of Object.values(this.autoTimers)) clearTimeout(t);
    this.autoTimers = {};
  }

  _render() {
    if (window.agcUI) window.agcUI._renderGuide();
  }
}

// ---------------------------------------------------------------------------
// Main UI Controller
// ---------------------------------------------------------------------------
class AGCUI {
  constructor() {
    this.agc         = new AGCCore();
    this.dsky        = new DSKY(this.agc);
    this.exec        = new Executive(this.agc);
    this.interpreter = new AGCInterpreter(this.agc);
    this.mission     = new MissionSimulator(this.dsky);
    this.guide       = new GuideTracker();
    this.pinball     = new Pinball(this.dsky);   // ← PINBALL state machine

    this.simTime     = 0;   // float seconds — drives all interpolation at frame rate
    this.simSpeed    = 30;
    this.paused      = false;
    this.currentPhase = FLIGHT_PHASES[0];

    window.agcUI = this;
  }

  init() {
    this.dsky.onUpdate = () => this._renderDSKY();
    this._bindKeys();
    this._startLoop();
    this._renderDSKY();
    this._renderRegisters();
    this._renderPhaseButtons();
    this._renderGuide();
    this.showAlarm('', '');
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------
  _startLoop() {
    let last = performance.now();
    const loop = (now) => {
      requestAnimationFrame(loop);
      const dt = Math.min(now - last, 100); // cap dt at 100ms
      last = now;

      if (!this.paused) {
        const prevFloor = Math.floor(this.simTime);
        // simTime is a float — interpolation runs at full frame rate (60 fps),
        // producing perfectly smooth register value changes at any speed setting
        this.simTime += (dt / 1000) * this.simSpeed;
        // Drive CPU/exec only for whole elapsed seconds to avoid browser blocking
        const newFloor  = Math.floor(this.simTime);
        const cpuTicks  = Math.min(newFloor - prevFloor, 60);
        for (let i = 0; i < cpuTicks; i++) {
          this.exec.tick();
          this.agc.runCycles(8);
        }
        // Pass the float time — MissionSimulator interpolates R1/R2/R3 every frame
        const phase = this.mission.update(this.simTime, this.pinball);

        // Auto-detect phase change
        if (phase.id !== this.currentPhase.id) {
          this.currentPhase = phase;
          this.guide.setPhase(phase.id);
          this._highlightPhaseButton(phase.id);
        }

        this._renderMissionStatus(phase);
      }
      this._renderRegisters();
    };
    requestAnimationFrame(loop);
  }

  // -------------------------------------------------------------------------
  // Jump to a flight phase
  // -------------------------------------------------------------------------
  jumpToPhase(phaseId) {
    const phase = FLIGHT_PHASES.find(p => p.id === phaseId);
    if (!phase) return;
    this.simTime = phase.get;
    this.currentPhase = phase;
    this.guide.setPhase(phaseId);
    this._highlightPhaseButton(phaseId);
    this.mission.alarmFired = {};
    // Reset PINBALL to auto mode when jumping phases
    this.pinball.userControlled = false;
    this.pinball.state = 'IDLE';
    this.pinball.verbBuf = '';
    this.pinball.nounBuf = '';
    this.pinball.pendingVerb = null;
    this.pinball.proAction = null;
    this.dsky.verbFlash = false;
    this.dsky.nounFlash = false;
    this._renderMissionStatus(phase);
  }

  _highlightPhaseButton(phaseId) {
    document.querySelectorAll('.phase-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.phase === phaseId);
    });
  }

  // -------------------------------------------------------------------------
  // Render phase jump buttons
  // -------------------------------------------------------------------------
  _renderPhaseButtons() {
    const container = document.getElementById('phase-buttons');
    if (!container) return;
    container.innerHTML = '';
    FLIGHT_PHASES.forEach(phase => {
      const btn = document.createElement('button');
      btn.className = 'phase-btn';
      btn.dataset.phase = phase.id;
      btn.innerHTML = `<span class="phase-btn-label">${phase.label}</span><span class="phase-btn-sub">${phase.subLabel}</span>`;
      btn.onclick = () => this.jumpToPhase(phase.id);
      container.appendChild(btn);
    });
    this._highlightPhaseButton(this.currentPhase.id);
  }

  // -------------------------------------------------------------------------
  // Render guided keystroke panel
  // -------------------------------------------------------------------------
  _renderGuide() {
    const container = document.getElementById('guide-panel');
    if (!container) return;

    const steps = this.guide.steps();
    const curStep = this.guide.currentStep;
    const phaseId = this.guide.currentPhaseId;
    const phase = FLIGHT_PHASES.find(p => p.id === phaseId);

    let html = `<div class="guide-phase-name">${phase ? phase.label.toUpperCase() : ''} — ${phase ? phase.desc : ''}</div>`;
    html += `<div class="guide-progress">Step ${curStep + 1} of ${steps.length}</div>`;
    html += `<div class="guide-steps">`;

    steps.forEach((step, i) => {
      const done    = this.guide.isDone(i);
      const active  = i === curStep;
      const future  = i > curStep;
      const cls     = done ? 'guide-step done' : active ? 'guide-step active' : 'guide-step future';

      html += `<div class="${cls}">`;
      html += `<div class="guide-step-header">`;
      html += `<span class="guide-step-num">${done ? '✓' : i + 1}</span>`;
      html += `<span class="guide-step-cue">${step.cue}</span>`;
      html += `</div>`;

      if (active) {
        // Key sequence display
        if (step.keys.length > 0) {
          html += `<div class="guide-keys">`;
          step.keys.forEach(k => {
            const cls2 = /^\d$/.test(k) ? 'gkey num' : 'gkey special';
            html += `<span class="${cls2}">${k}</span>`;
          });
          html += `</div>`;
        } else {
          html += `<div class="guide-keys auto"><span class="gkey-auto">AUTO</span></div>`;
        }
        html += `<div class="guide-purpose">${step.purpose}</div>`;
        if (step.expectedDisplay && step.expectedDisplay !== '—') {
          html += `<div class="guide-expected">Expected: <code>${step.expectedDisplay}</code></div>`;
        }
        if (step.keys.length > 0) {
          html += `<button class="guide-advance-btn" onclick="agcUI._guideAdvance()">Mark Done &amp; Next ▶</button>`;
        }
      }
      html += `</div>`;
    });

    html += `</div>`;

    // Navigation
    html += `<div class="guide-nav">`;
    if (curStep > 0) html += `<button class="guide-nav-btn" onclick="agcUI._guidePrev()">◀ Prev</button>`;
    if (curStep < steps.length - 1) html += `<button class="guide-nav-btn" onclick="agcUI._guideAdvance()">Next ▶</button>`;
    html += `</div>`;

    container.innerHTML = html;

    // Scroll active step into view
    const activeEl = container.querySelector('.guide-step.active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  _guideAdvance() {
    this.guide.advance();
  }

  _guidePrev() {
    if (this.guide.currentStep > 0) {
      this.guide.currentStep--;
      this.guide._render();
    }
  }

  // -------------------------------------------------------------------------
  // DSKY render
  // -------------------------------------------------------------------------
  _renderDSKY() {
    const state = this.dsky.getState();
    this._setSegments('verb-display', state.verb);
    this._setSegments('noun-display', state.noun);
    this._setSegments('prog-display', state.prog);
    this._setRegisterDisplay('r1', state.r1);
    this._setRegisterDisplay('r2', state.r2);
    this._setRegisterDisplay('r3', state.r3);
    for (const [name, on] of Object.entries(state.lights)) {
      const el = document.getElementById('light-' + name.toLowerCase().replace(/_/g, '-'));
      if (el) el.classList.toggle('on', on);
    }
    // Update R label annotations
    const phase = this.currentPhase;
    if (phase) {
      ['r1','r2','r3'].forEach((r, i) => {
        const lbl = document.getElementById(`reg-label-${r}`);
        if (lbl) lbl.textContent = phase[`${r}Label`] || '';
      });
    }
  }

  _setSegments(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    const chars = String(value).padStart(2, ' ');
    el.querySelectorAll('.seg-digit').forEach((s, i) => {
      const ch = chars[i] || ' ';
      s.dataset.digit = ch;
      s.className = 'seg-digit' + (ch === ' ' ? ' blank' : '');
    });
  }

  _setRegisterDisplay(id, arr) {
    const el = document.getElementById('reg-' + id);
    if (!el) return;
    const sign   = el.querySelector('.reg-sign');
    const digits = el.querySelectorAll('.reg-digit');
    if (sign) sign.textContent = arr[0] || ' ';
    digits.forEach((d, i) => {
      d.textContent   = arr[i + 1] || ' ';
      d.dataset.digit = arr[i + 1] || ' ';
    });
  }

  // -------------------------------------------------------------------------
  // Register panel
  // -------------------------------------------------------------------------
  _renderRegisters() {
    const regs = this.agc.dumpRegisters();
    const panel = document.getElementById('reg-panel');
    if (!panel) return;
    panel.innerHTML = `
      <div class="reg-row"><span>A</span><span>${regs.A}</span></div>
      <div class="reg-row"><span>L</span><span>${regs.L}</span></div>
      <div class="reg-row"><span>Q</span><span>${regs.Q}</span></div>
      <div class="reg-row"><span>Z (PC)</span><span>${regs.Z}</span></div>
      <div class="reg-row"><span>EB</span><span>${regs.EB}</span></div>
      <div class="reg-row"><span>FB</span><span>${regs.FB}</span></div>
      <div class="reg-row"><span>BB</span><span>${regs.BB}</span></div>
      <div class="reg-row"><span>MCT</span><span>${regs.cycles.toLocaleString()}</span></div>
      <div class="reg-row"><span>INHINT</span><span>${regs.inhibit ? 'YES' : 'NO'}</span></div>
    `;
  }

  _renderMissionStatus(phase) {
    const el = document.getElementById('mission-status');
    if (el) el.textContent = phase.label + ' — ' + phase.desc.slice(0, 55) + (phase.desc.length > 55 ? '…' : '');

    const timeEl = document.getElementById('mission-time');
    if (timeEl) {
      const t = Math.floor(this.simTime);
      const h = Math.floor(t / 3600);
      const m = Math.floor((t % 3600) / 60);
      const s = t % 60;
      timeEl.textContent = `GET ${String(h).padStart(3,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    }
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------
  _bindKeys() {
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'SELECT') return;
      if (e.key >= '0' && e.key <= '9') this._dskyKey(e.key);
      if (e.key === 'Enter')   this._dskyKey('ENTR');
      if (e.key === 'Escape')  this._dskyKey('CLR');
      if (e.key === 'v' || e.key === 'V') this._dskyKey('VERB');
      if (e.key === 'n' || e.key === 'N') this._dskyKey('NOUN');
      if (e.key === '+')       this._dskyKey('+');
      if (e.key === '-')       this._dskyKey('-');
      if (e.key === 'r' || e.key === 'R') this._dskyKey('RSET');
      if (e.key === 'p' || e.key === 'P') this._dskyKey('PRO');
      if (e.key === 'k' || e.key === 'K') this._dskyKey('KEYREL');
    });
    window.dskyPress = (key) => this._dskyKey(key);
  }

  _dskyKey(key) {
    // Flash COMP ACTY light briefly
    const compLight = document.getElementById('light-comp-acty');
    if (compLight) {
      compLight.classList.add('on');
      setTimeout(() => compLight.classList.remove('on'), 150);
    }

    // ── PINBALL handles the full VERB/NOUN state machine ──
    this.pinball.onKey(key);

    // ── Send hardware keycode to AGC via KEYRUPT ──
    this.dsky.pressKey(key);

    // Guide auto-advance on RSET
    if (key === 'RSET') this.guide.markDone();
  }

  showAlarm(code, label) {
    const el = document.getElementById('alarm-display');
    if (!el) return;
    if (!code) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.innerHTML = `<span class="alarm-code">${code}</span><span class="alarm-label">${label}</span>`;
    setTimeout(() => { el.style.display = 'none'; }, 5000);
  }

  setSpeed(s)  { this.simSpeed = parseFloat(s) || 30; }
  togglePause() {
    this.paused = !this.paused;
    const btn = document.getElementById('btn-pause');
    if (btn) btn.textContent = this.paused ? '▶ RESUME' : '⏸ PAUSE';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const ui = new AGCUI();
  ui.init();
  window.agcUI = ui;
});
