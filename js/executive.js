/**
 * AGC Executive — Cooperative Task Scheduler
 *
 * The real AGC Executive (EXECUTIVE.agc) is a priority-based cooperative
 * scheduler. Jobs are queued with a priority (0–high, 0o37777–low) and
 * run until they call ENDOFJOB, CHANG1/CHANG2, or FINDVAC.
 *
 * This JS implementation mirrors the scheduler semantics without executing
 * raw machine code — it drives named "jobs" (JS functions) that represent
 * the high-level mission programs.
 *
 * Waitlist handles time-delayed callbacks (real AGC WAITLIST.agc).
 */

'use strict';

class Job {
  constructor(id, priority, fn, label) {
    this.id       = id;
    this.priority = priority; // lower number = higher priority
    this.fn       = fn;
    this.label    = label || 'JOB';
    this.status   = 'PENDING'; // PENDING | RUNNING | WAITING | DONE
    this.wakeCycle = 0;
  }
}

class Executive {
  constructor(agc) {
    this.agc    = agc;
    this.jobs   = [];         // active job queue
    this.waitlist = [];       // time-delayed callbacks [{cycle, fn, label}]
    this._nextId = 0;
    this.currentJob = null;
    this.cycle  = 0;          // scheduler cycle counter (≈ AGC cycle count)

    // Logging
    this.log = [];
    this.maxLog = 200;
  }

  // -------------------------------------------------------------------------
  // NOVAC — schedule a no-VAC-area job (basic)
  // -------------------------------------------------------------------------
  novac(priority, fn, label) {
    const job = new Job(this._nextId++, priority, fn, label);
    this.jobs.push(job);
    this._sortJobs();
    this._addLog(`NOVAC: ${label} prio=${priority.toString(8)}`);
    return job;
  }

  // -------------------------------------------------------------------------
  // FINDVAC — schedule a job that needs a VAC area (interpretive)
  // -------------------------------------------------------------------------
  findvac(priority, fn, label) {
    return this.novac(priority, fn, label); // simplified: same queue
  }

  // -------------------------------------------------------------------------
  // WAITLIST — call fn after `ticks` AGC cycles (real: 10ms increments)
  // -------------------------------------------------------------------------
  waitlist(ticks, fn, label) {
    this.waitlist.push({ cycle: this.cycle + ticks, fn, label: label || 'WAIT' });
    this.waitlist.sort((a, b) => a.cycle - b.cycle);
    this._addLog(`WAITLIST: ${label} in ${ticks} cycles`);
  }

  // -------------------------------------------------------------------------
  // Tick — advance scheduler by one "Executive cycle"
  // Each call represents one scheduling opportunity.
  // -------------------------------------------------------------------------
  tick() {
    this.cycle++;

    // Fire any due waitlist items
    while (this.waitlist.length && this.waitlist[0].cycle <= this.cycle) {
      const item = this.waitlist.shift();
      this._addLog(`WAITLIST fire: ${item.label}`);
      try { item.fn(); } catch(e) { this._addLog(`WAITLIST ERR: ${e.message}`); }
    }

    // Run highest-priority pending job (one step)
    const job = this._nextJob();
    if (!job) return;

    this.currentJob = job;
    job.status = 'RUNNING';

    try {
      const result = job.fn(job);
      // If fn returns a Promise (async job), wait for it
      if (result && typeof result.then === 'function') {
        job.status = 'WAITING';
        result.then(() => {
          job.status = 'DONE';
          this.jobs = this.jobs.filter(j => j !== job);
          this._addLog(`DONE (async): ${job.label}`);
        }).catch(e => {
          job.status = 'DONE';
          this.jobs = this.jobs.filter(j => j !== job);
          this._addLog(`ERR: ${job.label}: ${e.message}`);
        });
      } else {
        // Synchronous job: mark done and remove
        job.status = 'DONE';
        this.jobs = this.jobs.filter(j => j !== job);
        this._addLog(`DONE: ${job.label}`);
      }
    } catch(e) {
      job.status = 'DONE';
      this.jobs = this.jobs.filter(j => j !== job);
      this._addLog(`ERR: ${job.label}: ${e.message}`);
    }

    this.currentJob = null;
  }

  // -------------------------------------------------------------------------
  // ENDOFJOB — called by a job to terminate itself voluntarily
  // -------------------------------------------------------------------------
  endofjob() {
    if (this.currentJob) {
      this.currentJob.status = 'DONE';
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------
  _nextJob() {
    return this.jobs.find(j => j.status === 'PENDING') || null;
  }

  _sortJobs() {
    this.jobs.sort((a, b) => a.priority - b.priority);
  }

  _addLog(msg) {
    this.log.push(`[${this.cycle}] ${msg}`);
    if (this.log.length > this.maxLog) this.log.shift();
  }

  getJobList() {
    return this.jobs.map(j => ({
      id: j.id, label: j.label, priority: j.priority.toString(8), status: j.status
    }));
  }

  getLog() {
    return [...this.log];
  }
}

if (typeof module !== 'undefined') module.exports = { Executive, Job };
else window.Executive = Executive;
