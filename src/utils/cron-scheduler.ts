import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { parse, stringify } from "yaml";
import { CronExpressionParser } from "cron-parser";
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
  nextRun?: string;
}

export type CronJobCallback = (job: CronJob) => Promise<void>;

function nextRunDate(schedule: string): Date {
  return CronExpressionParser.parse(schedule).next().toDate();
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
  private jobs: Map<string, CronJob> = new Map();
  private callback: CronJobCallback;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(callback: CronJobCallback) {
    this.callback = callback;
  }

  start(): void {
    const saved = loadJobs();
    for (const job of saved) {
      try {
        CronExpressionParser.parse(job.schedule);
        this.jobs.set(job.id, job);
        logger.info(`Cron job "${job.name}" (${job.id}) loaded, schedule=${job.schedule}, nextRun=${job.nextRun}`);
      } catch (err) {
        logger.warn(`Cron job "${job.name}" (${job.id}) has invalid schedule "${job.schedule}" (${(err as Error).message}), skipping`);
      }
    }
    this.persist();
    this.tick();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  add(input: CronJobInput): CronJob {
    let schedule: string;
    try {
      schedule = CronExpressionParser.parse(input.schedule).stringify();
    } catch {
      throw new Error(`Invalid schedule: "${input.schedule}"`);
    }

    const id = crypto.randomUUID().slice(0, 8);
    const nextRun = nextRunDate(schedule).toISOString();
    const job: CronJob = {
      id,
      name: input.name,
      schedule,
      prompt: input.prompt,
      channelId: input.channelId,
      directory: input.directory,
      to: input.to,
      nextRun,
    };
    this.jobs.set(id, job);
    logger.info(`Cron job "${job.name}" (${id}) added, schedule=${schedule}, nextRun=${nextRun}`);
    this.persist();
    this.scheduleNext();
    return job;
  }

  remove(id: string): boolean {
    const job = this.jobs.get(id);
    const deleted = this.jobs.delete(id);
    if (deleted) {
      logger.info(`Cron job "${job?.name}" (${id}) removed`);
      this.persist();
      this.scheduleNext();
    }
    return deleted;
  }

  list(): CronJob[] {
    return Array.from(this.jobs.values());
  }

  async trigger(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Cron job "${id}" not found`);
    await this.callback(job);
  }

  private persist(): void {
    saveJobs(Array.from(this.jobs.values()));
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

    const now = Date.now();
    let nearestMs = Infinity;
    let nearestJob: CronJob | undefined;

    for (const job of this.jobs.values()) {
      if (!job.nextRun) continue;
      const ms = new Date(job.nextRun).getTime() - now;
      if (ms <= 0) {
        logger.info(`Cron job "${job.name}" (${job.id}) firing (was scheduled for ${job.nextRun})`);
        this.fireJob(job);
        job.nextRun = nextRunDate(job.schedule).toISOString();
        logger.info(`Cron job "${job.name}" (${job.id}) next run scheduled for ${job.nextRun}`);
        this.persist();
        continue;
      }
      if (ms < nearestMs) {
        nearestMs = ms;
        nearestJob = job;
      }
    }

    if (nearestMs === Infinity) return;
    if (nearestMs < 1000) nearestMs = 1000;

    logger.debug(`Next cron tick in ${nearestMs}ms for "${nearestJob?.name}" (${nearestJob?.id})`);

    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.tick();
    }, nearestMs);
  }

  private fireJob(job: CronJob): void {
    this.callback(job)
      .then(() => logger.info(`Cron job "${job.name}" (${job.id}) completed`))
      .catch((err: Error) => {
        logger.error(`Cron job "${job.name}" (${job.id}) failed: ${err.message}`);
      });
  }
}
