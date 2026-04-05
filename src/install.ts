import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRl, question } from "./readline.js";
import logger from "./utils/logger.js";

const UNIT_NAME = "jiegeclaw.service";
const SYSTEMD_USER_DIR = path.join(os.homedir(), ".config", "systemd", "user");

function getServiceUnitContent(): string {
  return [
    `[Unit]`,
    `Description=Jiegec's personal AI assistant`,
    `After=network-online.target`,
    `Wants=network-online.target`,
    ``,
    `[Service]`,
    `Type=simple`,
    `ExecStart=/usr/bin/env npm start`,
    `WorkingDirectory=${process.cwd()}`,
    `Environment=NODE_ENV=production`,
    `Restart=on-failure`,
    `RestartSec=5`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
    ``,
  ].join("\n");
}

async function confirmOrAbort(rl: ReturnType<typeof createRl>, prompt: string): Promise<void> {
  const answer = await question(rl, `${prompt} [Y/n] `);
  if (answer.toLowerCase() !== "" && answer.toLowerCase() !== "y") {
    logger.info("Aborted.");
    process.exit(0);
  }
}

function run(cmd: string, label: string): void {
  logger.info(`${label}...`);
  execSync(cmd, { stdio: "inherit", env: process.env });
  logger.info(`${label} ✓`);
}

export async function install(): Promise<void> {
  const unitPath = path.join(SYSTEMD_USER_DIR, UNIT_NAME);
  const unitContent = getServiceUnitContent();

  logger.info(`Systemd user unit will be written to:`);
  logger.info(`  ${unitPath}`);
  logger.info(`\n--- Unit file ---`);
  logger.info(unitContent);

  const rl = createRl();

  await confirmOrAbort(rl, "Write systemd unit file?");

  fs.mkdirSync(SYSTEMD_USER_DIR, { recursive: true });
  fs.writeFileSync(unitPath, unitContent, { mode: 0o644 });

  await confirmOrAbort(rl, "Enable linger (service starts at boot without login)?");

  run(`loginctl enable-linger ${os.userInfo().username}`, "Enabling linger");

  await confirmOrAbort(rl, "Reload systemd daemon?");

  run("systemctl --user daemon-reload", "Reloading systemd daemon");

  await confirmOrAbort(rl, "Start and enable the service?");

  run(`systemctl --user start ${UNIT_NAME}`, `Starting ${UNIT_NAME}`);
  run(`systemctl --user enable ${UNIT_NAME}`, `Enabling ${UNIT_NAME}`);

  logger.info("Installation complete!");
  logger.info(`Check status: systemctl --user status ${UNIT_NAME}`);

  rl.close();
}
