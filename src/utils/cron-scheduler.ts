import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { parse, stringify } from "yaml";
import { parseSchedule, nextCronMs } from "./cron-parser.js";
import logger from "./logger.js";

const CONFIG_DIR = path.join(os.homedir(), ".jiegeclaw");
const CRON_PATH = path.join(CONFIG_DIR, "cron.yaml");

export interface CronJobInput {
  name: string;
  schedule: string;
  prompt: string;
  channelId: string;
  directory: string;
  to: string;
}

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  channelId: string;
  directory: string;
  to: string;
  nextRun?: Date;
}

export type CronJobCallback = (job: CronJob) => Promise<void>;

interface InternalJob extends CronJob {
  fields: string[];
}

function loadJobs(): CronJob[] {
  try {
    const raw = fs.readFileSync(CRON_PATH, "utf-8");
    const jobs = parse(raw) as CronJob[];
    return Array.isArray(jobs) ? jobs : [];
  } catch {
    return [];
  }
}

function saveJobs(jobs: CronJob[]): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CRON_PATH, stringify(jobs), { mode: 0o600, encoding: "utf-8" });
}

export class CronScheduler {
  private jobs: Map<string, InternalJob> = new Map();
  private callback: CronJobCallback;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(callback: CronJobCallback) {
    this.callback = callback;
  }

  start(): void {
    const saved = loadJobs();
    for (const job of saved) {
      const fields = job.schedule.split(/\s+/);
      if (fields.length !== 5) {
        logger.warn(`Cron job "${job.name}" (${job.id}) has invalid schedule "${job.schedule}", skipping`);
        continue;
      }
      this.jobs.set(job.id, { ...job, fields });
      logger.info(`Cron job "${job.name}" (${job.id}) loaded with schedule ${job.schedule}`);
    }
    this.tick();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  add(input: CronJobInput): CronJob {
    const cron = parseSchedule(input.schedule);
    if (!cron) throw new Error(`Invalid schedule: "${input.schedule}"`);

    const id = crypto.randomUUID().slice(0, 8);
    const fields = cron.split(/\s+/);
    const job: InternalJob = {
      id,
      name: input.name,
      schedule: cron,
      prompt: input.prompt,
      channelId: input.channelId,
      directory: input.directory,
      to: input.to,
      fields,
    };
    this.jobs.set(id, job);
    this.persist();
    this.scheduleNext();
    return job;
  }

  remove(id: string): boolean {
    const deleted = this.jobs.delete(id);
    if (deleted) {
      this.persist();
      this.scheduleNext();
    }
    return deleted;
  }

  list(): CronJob[] {
    const now = new Date();
    return Array.from(this.jobs.values()).map((j) => ({
      id: j.id,
      name: j.name,
      schedule: j.schedule,
      prompt: j.prompt,
      channelId: j.channelId,
      directory: j.directory,
      to: j.to,
      nextRun: new Date(now.getTime() + nextCronMs(j.fields, now)),
    }));
  }

  async trigger(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Cron job "${id}" not found`);
    await this.callback(job);
  }

  private persist(): void {
    saveJobs(Array.from(this.jobs.values()).map(({ fields: _f, ...rest }) => rest));
  }

  private scheduleNext(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.tick();
  }

  private tick(): void {
    if (this.jobs.size === 0) return;

    const now = new Date();
    let nearestMs = Infinity;

    for (const job of this.jobs.values()) {
      const ms = nextCronMs(job.fields, now);
      if (ms <= 0) {
        this.fireJob(job);
        continue;
      }
      if (ms < nearestMs) nearestMs = ms;
    }

    if (nearestMs === Infinity) return;
    if (nearestMs < 1000) nearestMs = 1000;

    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.tick();
    }, nearestMs);
  }

  private fireJob(job: InternalJob): void {
    this.callback(job).catch((err: Error) => {
      logger.error(`Cron job "${job.name}" (${job.id}) failed: ${err.message}`);
    });
  }
}
