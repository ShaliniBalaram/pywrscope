// scripts/setup-python.js — cross-platform launcher for setup-python-runtime.
//
// The actual logic lives in setup-python-runtime.sh (macOS/Linux) and
// setup-python-runtime.ps1 (Windows). This wrapper lets every entry point
// (package.json scripts, CI workflows, local dev) call the same npm script
// — `npm run setup:python` — and have it dispatch to the right interpreter
// for the host OS. Single source of truth for "how to set up the runtime."

const { spawnSync } = require("child_process");
const path = require("path");

const scriptDir = __dirname;
const isWindows = process.platform === "win32";

const command = isWindows ? "pwsh" : "bash";
const args = isWindows
  ? ["-ExecutionPolicy", "Bypass", "-File", path.join(scriptDir, "setup-python-runtime.ps1")]
  : [path.join(scriptDir, "setup-python-runtime.sh")];

const result = spawnSync(command, args, { stdio: "inherit" });

if (result.error) {
  console.error(`[setup-python.js] failed to spawn ${command}: ${result.error.message}`);
  if (isWindows && result.error.code === "ENOENT") {
    console.error("[setup-python.js] pwsh not found. Install PowerShell 7 from https://github.com/PowerShell/PowerShell or run the .ps1 directly.");
  }
  process.exit(1);
}

process.exit(result.status ?? 1);
