"use strict";
// Registers one current-user native host. No administrator rights or credentials.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {spawnSync} = require("node:child_process");
const {ROOT} = require("./supervisor.js");
const NAME = "com.job_application_assistant.launcher";

function stableId() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "extension/manifest.json"), "utf8"));
  return crypto.createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32)
    .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
}
function safeBatchPath(value) {
  if (/[\r\n%"!]/.test(value)) throw new Error("This installation path contains unsupported batch characters.");
  return value;
}
function install() {
  if (process.platform !== "win32") throw new Error("This installer is for Windows Chrome.");
  const id = stableId();
  const folder = path.join(__dirname, "generated");
  fs.mkdirSync(folder, {recursive: true});
  const launcher = path.join(folder, "native-host.bat");
  fs.writeFileSync(launcher, `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${safeBatchPath(process.execPath)}" "${safeBatchPath(path.join(__dirname, "native-host.js"))}" %*\r\n`);
  const manifest = path.join(folder, `${NAME}.json`);
  fs.writeFileSync(manifest, JSON.stringify({name: NAME, description: "Job assistants: Chrome-managed local startup and shutdown", path: launcher,
    type: "stdio", allowed_origins: [`chrome-extension://${id}/`]}, null, 2));
  const result = spawnSync("reg.exe", ["ADD", `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NAME}`, "/ve", "/t", "REG_SZ", "/d", manifest, "/f"],
    {encoding: "utf8", windowsHide: true});
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "Chrome helper registration failed.");
  console.log("Shared Chrome helper installed for unified extension ID: " + id);
  console.log("Reload the unified extension. Close old companion windows once; future helpers start and stop with Chrome.");
}
if (require.main === module) { try { install(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = {stableId, safeBatchPath};
