import { ingestTransactions, persistTransactions } from "../transactions/index.js";
import { createCsvParser, parseHeader, mapRow } from "../import-excel/csv.js";
import { recomputeCompany } from "../recompute/index.js";
import { loadConfigVersion } from "../../lib/company-data.js";

// SyncDriver — a per-company Durable Object that runs the day-window pull IN THE BACKGROUND.
//
// Why a DO: it's single-threaded, so only one alarm ever runs at a time for a given company —
// no two things race on the same job (the auth/capture overwrite worry can't happen here). It
// self-continues via alarms: each alarm processes one ~22s time-boxed batch, records progress,
// and (if more remains) schedules the next alarm immediately. The browser only kicks it off and
// polls status — close the tab and the DO keeps going until done.
//
// One DO per company: env.SYNC_DRIVER.idFromName("company:" + companyId).

const TIME_BUDGET_MS = 22_000;   // per alarm; headroom under the Worker CPU limit

// ── R2 background import knobs ──
const R2_CHUNK = 4 * 1024 * 1024;   // bytes byte-range-read from R2 per step (~4MB ≈ tens of k rows)
const R2_TIME_BUDGET_MS = 20_000;   // wall-clock per alarm tick for the R2 job (mostly awaited I/O)

// Decode a byte slice [start,end) as UTF-8. On the very first bytes of the file, drop a UTF-8 BOM.
function decodeChunk(buf, start, end, atFileStart) {
  let s = start;
  if (atFileStart && end - start >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) s = 3;
  return new TextDecoder("utf-8").decode(buf.subarray(s, end));
}

// index of the last 0x0A (newline) in buf, or -1. Newline is single-byte ASCII, so cutting there
// is always on a UTF-8 character boundary — the text before it decodes cleanly.
function lastNewline(buf) {
  for (let i = buf.length - 1; i >= 0; i--) if (buf[i] === 0x0A) return i;
  return -1;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

function dayCount(startISO, endISO) {
  const s = Date.parse(startISO + "T00:00:00Z"), e = Date.parse(endISO + "T00:00:00Z");
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return 0;
  return Math.floor((e - s) / 86_400_000) + 1;
}

export class SyncDriver {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/start" && request.method === "POST") {
      const b = await request.json();

      // Background recompute: materialize suggestions + bank_mid for a just-published config
      // version (stored is_current=0), then flip is_current to it ONLY on success. Runs in its
      // OWN DO instance (idFromName "publish:<cid>") so it never contends with the sync/import job.
      if (b.source === "recompute") {
        const job = {
          source: "recompute",
          companyId: b.companyId,
          version: b.version,
          status: "running",
          banksUpdated: 0,
          error: null,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await this.state.storage.put("job", job);
        await this.state.storage.setAlarm(Date.now() + 50);
        return json({ started: true, job });
      }

      // R2 background import: process a CSV already sitting in the bucket, resumably.
      if (b.source === "r2") {
        const job = {
          source: "r2",
          companyId: b.companyId,
          key: b.key,
          mode: b.mode === "overwrite" ? "overwrite" : "missing",
          byteCursor: 0,          // next byte to read from the object
          size: 0,                // learned from the object's head on the first tick
          columns: null,          // the parsed header {name:index}; stored once, reused every tick
          status: "running",
          totalRows: 0,           // data rows seen with a numeric transactionId
          totalPersisted: 0,      // rows written after filter/reconcile
          error: null,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await this.state.storage.put("job", job);
        await this.state.storage.setAlarm(Date.now() + 50);
        return json({ started: true, job });
      }

      const job = {
        companyId: b.companyId,
        startDate: b.startDate,
        endDate: b.endDate,
        mode: b.mode === "overwrite" ? "overwrite" : "missing",
        cursor: b.startDate,          // next day to process
        status: "running",
        totalRows: 0,                 // raw rows fetched from CC
        totalPersisted: 0,            // rows written after filter/reconcile
        daysDone: 0,
        totalDays: dayCount(b.startDate, b.endDate),
        failed: 0,                    // days that errored (still advanced past; re-run to fill)
        through: null,                // last day fully processed
        error: null,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await this.state.storage.put("job", job);
      await this.state.storage.setAlarm(Date.now() + 50);   // fire ASAP
      return json({ started: true, job });
    }

    if (url.pathname === "/status") {
      const job = await this.state.storage.get("job");
      return json(job || { status: "idle" });
    }

    if (url.pathname === "/cancel" && request.method === "POST") {
      const job = await this.state.storage.get("job");
      if (job && job.status === "running") {
        job.status = "cancelled";
        job.updatedAt = new Date().toISOString();
        await this.state.storage.put("job", job);
      }
      await this.state.storage.deleteAlarm();
      return json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  }

  async alarm() {
    const job = await this.state.storage.get("job");
    if (!job || job.status !== "running") return;   // cancelled / done / gone → stop
    if (job.source === "recompute") return this.alarmRecompute(job);
    if (job.source === "r2") return this.alarmR2(job);

    try {
      // Pull the company's own CheckoutChamp creds each tick (never store them in the DO).
      const c = await this.env.DB.prepare(
        "SELECT cc_login, cc_password FROM companies WHERE id = ?"
      ).bind(job.companyId).first();

      // Totals at the start of this tick; onProgress advances them after each ~1-2s day-chunk so
      // the status (and the UI) moves right away instead of only once the whole tick finishes.
      const base = { days: job.daysDone, rows: job.totalRows, persisted: job.totalPersisted };
      const r = await ingestTransactions(this.env, {
        startDate: job.startDate,
        endDate: job.endDate,
        fromDate: job.cursor,
        timeBudgetMs: TIME_BUDGET_MS,
        companyId: job.companyId,
        creds: { login: c?.cc_login, password: c?.cc_password },
        mode: job.mode,
        onProgress: async (p) => {
          job.daysDone = base.days + (p.daysProcessed || 0);
          job.totalRows = base.rows + (p.totalFetched || 0);
          job.totalPersisted = base.persisted + (p.totalPersisted || 0);
          if (p.throughDate) job.through = p.throughDate;
          job.updatedAt = new Date().toISOString();
          await this.state.storage.put("job", job);
        },
      });

      if (r.error) {
        job.status = "error";
        job.error = r.error + (r.detail ? ` — ${r.detail}` : "");
      } else {
        // onProgress already advanced days/rows/persisted/through to this tick's end — don't re-add.
        job.failed += (r.failedDays || []).length;
        job.cursor = r.nextDate || job.cursor;
        job.status = r.hasMore ? "running" : "done";
      }
      job.updatedAt = new Date().toISOString();
      await this.state.storage.put("job", job);

      if (job.status === "running") {
        await this.state.storage.setAlarm(Date.now() + 50);   // continue with the next batch
      }
    } catch (err) {
      job.status = "error";
      job.error = String(err?.message || err);
      job.updatedAt = new Date().toISOString();
      await this.state.storage.put("job", job);
    }
  }

  // Recompute job: materialize the just-published config version, then atomically flip is_current
  // to it — but ONLY if the recompute succeeded. On any failure is_current is left untouched, so
  // the previously-live config keeps serving and the error is recorded for the UI to surface.
  // recomputeCompany is a single all-or-nothing operation (chunked, atomic DELETE+insert per table)
  // and is I/O-bound, so it runs to completion in one alarm — no self-continue needed.
  async alarmRecompute(job) {
    try {
      const config = await loadConfigVersion(this.env, job.companyId, job.version);
      if (!config) {
        job.status = "error";
        job.error = `config version ${job.version} not found`;
        job.updatedAt = new Date().toISOString();
        await this.state.storage.put("job", job);
        return;
      }

      const rc = await recomputeCompany(this.env, job.companyId, config);
      if (rc.error) {
        job.status = "error";
        job.error = rc.error;   // is_current NOT flipped → the old config stays live
      } else {
        await this.env.DB.batch([
          this.env.DB.prepare("UPDATE config_versions SET is_current = 0 WHERE company_id = ?").bind(job.companyId),
          this.env.DB.prepare("UPDATE config_versions SET is_current = 1 WHERE company_id = ? AND version = ?").bind(job.companyId, job.version),
        ]);
        job.status = "done";
        job.banksUpdated = rc.banksUpdated;
        job.cacheHit = !!rc.cacheHit;
      }
      job.updatedAt = new Date().toISOString();
      await this.state.storage.put("job", job);
    } catch (err) {
      job.status = "error";
      job.error = String(err?.message || err);
      job.updatedAt = new Date().toISOString();
      await this.state.storage.put("job", job);
    }
  }

  // R2 job: byte-range-read the object in chunks, parse only COMPLETE rows (cut at the last newline
  // in each chunk, re-reading the partial trailing row as the head of the next chunk), and persist
  // through the SAME model as the CSV/API import. One tick processes chunks until the time budget,
  // then self-continues via another alarm until byteCursor reaches size.
  async alarmR2(job) {
    const tickStart = Date.now();
    try {
      // Learn the object size once (first tick).
      if (!job.size) {
        const head = await this.env.CSV_BUCKET.head(job.key);
        if (!head) {
          job.status = "error";
          job.error = `object not found in bucket: ${job.key}`;
          job.updatedAt = new Date().toISOString();
          await this.state.storage.put("job", job);
          return;
        }
        job.size = head.size;
      }

      // Header is parsed once (first tick) and then reused every tick via job.columns.
      let col = job.columns || null;
      let headerFound = col != null;
      let fatal = null;
      let batch = [];
      const flush = async () => {
        if (!batch.length) return;
        await persistTransactions(this.env, batch, job.companyId, job.mode);
        job.totalPersisted += batch.length;
        batch = [];
      };
      const onRow = (row) => {
        if (fatal) return;
        if (!headerFound) {
          const h = parseHeader(row);
          if (!h) return;                             // preamble
          if (h.error) { fatal = h.error; return; }
          col = h.col; headerFound = true; job.columns = col;
          return;
        }
        const m = mapRow(row, col);
        if (m.skip === "notxnid") return;
        job.totalRows++;
        if (m.skip === "type" || m.skip === "invalid") return;
        batch.push(m.txn);
      };

      while (job.byteCursor < job.size && Date.now() - tickStart < R2_TIME_BUDGET_MS) {
        const length = Math.min(R2_CHUNK, job.size - job.byteCursor);
        const obj = await this.env.CSV_BUCKET.get(job.key, { range: { offset: job.byteCursor, length } });
        if (!obj) { fatal = `object not found in bucket: ${job.key}`; break; }
        const buf = new Uint8Array(await obj.arrayBuffer());
        const atFileStart = job.byteCursor === 0;
        const atEof = job.byteCursor + buf.length >= job.size;
        const parser = createCsvParser();   // each chunk is row-aligned, so a fresh parser per chunk is safe

        if (atEof) {
          parser.feed(decodeChunk(buf, 0, buf.length, atFileStart), onRow);
          parser.finish(onRow);             // flush a final row with no trailing newline
          job.byteCursor = job.size;
        } else {
          const nl = lastNewline(buf);
          if (nl < 0) { fatal = "a single row exceeds the read chunk size"; break; }
          parser.feed(decodeChunk(buf, 0, nl + 1, atFileStart), onRow);
          job.byteCursor += nl + 1;         // partial trailing row is re-read next chunk
        }

        await flush();
        if (fatal) break;
        job.updatedAt = new Date().toISOString();
        await this.state.storage.put("job", job);
      }
      await flush();   // safety; batch is normally empty here

      if (fatal) { job.status = "error"; job.error = fatal; }
      else if (job.byteCursor >= job.size) { job.status = "done"; }
      else { job.status = "running"; }
      job.updatedAt = new Date().toISOString();
      await this.state.storage.put("job", job);

      if (job.status === "running") await this.state.storage.setAlarm(Date.now() + 50);
    } catch (err) {
      job.status = "error";
      job.error = String(err?.message || err);
      job.updatedAt = new Date().toISOString();
      await this.state.storage.put("job", job);
    }
  }
}
