import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAXOS_HOME = process.env.MAXOS_HOME || join(homedir(), ".maxos");

export function installService(): void {
  const os = platform();

  if (os === "darwin") {
    installLaunchd();
  } else if (os === "linux") {
    installSystemd();
  } else {
    console.error(`Unsupported platform: ${os}. Use 'maxos start --foreground' instead.`);
    process.exit(1);
  }
}

export function uninstallService(): void {
  const os = platform();
  if (os === "darwin") uninstallLaunchd();
  else if (os === "linux") uninstallSystemd();
}

function installLaunchd(): void {
  const templatePath = join(__dirname, "..", "services", "com.maxos.daemon.plist");
  let plist = readFileSync(templatePath, "utf-8");

  const nodePath = execSync("which node", { encoding: "utf-8" }).trim();
  const entryPath = join(__dirname, "..", "dist", "index.js");
  const workspacePath = join(MAXOS_HOME, "workspace");
  const envPath = process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

  plist = plist
    .replace(/__NODE_PATH__/g, nodePath)
    .replace(/__MAXOS_ENTRY__/g, entryPath)
    .replace(/__WORKSPACE_PATH__/g, workspacePath)
    .replace(/__PATH__/g, envPath)
    .replace(/__HOME__/g, homedir())
    .replace(/__MAXOS_HOME__/g, MAXOS_HOME);

  const plistPath = join(homedir(), "Library", "LaunchAgents", "com.maxos.daemon.plist");
  writeFileSync(plistPath, plist);

  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: "pipe" });
  } catch {
    // Ignore if not currently loaded
  }
  execSync(`launchctl load "${plistPath}"`);

  console.log(`\u2705 Installed launchd service at ${plistPath}`);
  console.log("   MaxOS will start automatically on login.");
  console.log("   Stop with: launchctl unload ~/Library/LaunchAgents/com.maxos.daemon.plist");
}

function uninstallLaunchd(): void {
  const plistPath = join(homedir(), "Library", "LaunchAgents", "com.maxos.daemon.plist");
  if (existsSync(plistPath)) {
    try {
      execSync(`launchctl unload "${plistPath}"`, { stdio: "pipe" });
    } catch {
      // Ignore if not currently loaded
    }
    unlinkSync(plistPath);
    console.log("\u2705 Removed launchd service.");
  } else {
    console.log("No launchd service found.");
  }
}

function installSystemd(): void {
  const templatePath = join(__dirname, "..", "services", "maxos.service");
  let unit = readFileSync(templatePath, "utf-8");

  const nodePath = execSync("which node", { encoding: "utf-8" }).trim();
  const entryPath = join(__dirname, "..", "dist", "index.js");
  const workspacePath = join(MAXOS_HOME, "workspace");
  const envPath = process.env.PATH || "/usr/local/bin:/usr/bin:/bin";

  unit = unit
    .replace(/__NODE_PATH__/g, nodePath)
    .replace(/__MAXOS_ENTRY__/g, entryPath)
    .replace(/__WORKSPACE_PATH__/g, workspacePath)
    .replace(/__PATH__/g, envPath)
    .replace(/__MAXOS_HOME__/g, MAXOS_HOME);

  const unitDir = join(homedir(), ".config", "systemd", "user");
  mkdirSync(unitDir, { recursive: true });
  const unitPath = join(unitDir, "maxos.service");
  writeFileSync(unitPath, unit);

  execSync("systemctl --user daemon-reload");
  execSync("systemctl --user enable maxos");
  execSync("systemctl --user start maxos");

  console.log(`\u2705 Installed systemd service at ${unitPath}`);
  console.log("   MaxOS will start automatically on login.");
  console.log("   Stop with: systemctl --user stop maxos");
}

function uninstallSystemd(): void {
  try {
    execSync("systemctl --user stop maxos", { stdio: "pipe" });
    execSync("systemctl --user disable maxos", { stdio: "pipe" });
  } catch {
    // Ignore if not currently running
  }
  const unitPath = join(homedir(), ".config", "systemd", "user", "maxos.service");
  if (existsSync(unitPath)) {
    unlinkSync(unitPath);
    execSync("systemctl --user daemon-reload");
    console.log("\u2705 Removed systemd service.");
  } else {
    console.log("No systemd service found.");
  }
}
