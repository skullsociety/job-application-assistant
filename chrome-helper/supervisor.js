"use strict";

const fs = require("node:fs");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const {spawn} = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const ID = crypto.createHash("sha256").update(ROOT.toLowerCase()).digest("hex").slice(0, 16);
const PIPE = process.platform === "win32" ? `\\\\.\\pipe\\job-assistants-${ID}` : path.join(ROOT, "tmp", `job-assistants-${ID}.sock`);
const SERVICES = [
  {folder: "jobstreet", port: 8767, service: "JobStreet Job Application Assistant"},
  {folder: "linkedin", port: 8766, service: "LinkedIn Job Application Assistant"},
  {folder: "careersgov", port: 8765, service: "Careers@Gov Companion"},
];

function health(service) {
  return new Promise(resolve => {
    const request = http.get(`http://127.0.0.1:${service.port}/api/health`, {timeout: 800}, response => {
      let body = "";
      response.on("data", chunk => { body += chunk; if (body.length > 8192) request.destroy(); });
      response.on("end", () => {
        try { const data = JSON.parse(body); resolve(response.statusCode === 200 && data.ok && data.service === service.service); }
        catch { resolve(false); }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

function pythonFor(folder) {
  const candidates = [
    path.join(ROOT, ".venv", "Scripts", "python.exe"),
    path.join(ROOT, folder, ".venv", "Scripts", "python.exe"),
    path.join(ROOT, "jobstreet", ".venv", "Scripts", "python.exe"),
  ];
  const executable = candidates.find(candidate => fs.existsSync(candidate));
  if (!executable) throw new Error("Run Setup Job Assistant Suite.bat first. The local Python environment is missing.");
  return executable;
}

function stopChild(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || !child.pid) return resolve();
    // Windows venv launchers can have a child interpreter. Target only this
    // supervisor's still-running process tree, never all Python/CMD processes.
    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {windowsHide: true, stdio: "ignore"});
      killer.on("exit", resolve);
      killer.on("error", resolve);
    } else { child.kill("SIGTERM"); child.once("exit", resolve); }
  });
}

function syncOnShutdown() {
  const script = path.join(ROOT, "sync_to_aws.py");
  const database = path.join(ROOT, "local-data", "jobs.sqlite3");
  if (!fs.existsSync(path.join(ROOT, ".env")) || !fs.existsSync(script) || !fs.existsSync(database)) return Promise.resolve();
  const logPath = path.join(ROOT, "local-data", "logs", "aws-sync.log");
  const log = fs.openSync(logPath, "a");
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(pythonFor("jobstreet"), [script, "--drain"], {
        cwd: ROOT, windowsHide: true, stdio: ["ignore", log, log],
      });
    } catch (error) {
      fs.closeSync(log);
      reject(error);
      return;
    }
    fs.closeSync(log);
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`AWS sync exited with code ${code}.`)));
  });
}

function runSupervisor({services = SERVICES, pipe = PIPE, spawnService, checkHealth = health, stopService = stopChild, syncPending = syncOnShutdown, idleMs = 3000} = {}) {
  const clients = new Set();
  const children = new Map();
  let startup = null;
  let idleTimer;
  let stopping = false;
  let shutdownPromise;
  const localData = path.join(ROOT, "local-data");
  const logDir = path.join(localData, "logs");
  fs.mkdirSync(logDir, {recursive: true});
  function startService(service) {
    const log = fs.openSync(path.join(logDir, `${service.folder}.log`), "a");
    try {
      return spawn(pythonFor(service.folder), ["-m", "companion.server"], {
        cwd: path.join(ROOT, service.folder), windowsHide: true,
        env: {
          ...process.env,
          JOB_ASSISTANT_HOME: path.join(ROOT, service.folder),
          JOB_ASSISTANT_DATABASE_PATH: path.join(localData, "jobs.sqlite3"),
          JOB_ASSISTANT_EXPORT_PATH: path.join(localData, "exports", "job_tracker.xlsx"),
          JOB_ASSISTANT_RESUME_DIR: path.join(localData, "resumes"),
          JOB_ASSISTANT_TAILORED_RESUME_DIR: path.join(localData, "exports", "tailored_resumes"),
          JOB_ASSISTANT_USER_DATA_DIR: path.join(localData, "browser-profile"),
          JOB_ASSISTANT_PROFILE_PATH: path.join(localData, "private", `${service.folder}-profile.json`),
          JOB_ASSISTANT_LOG_PATH: path.join(logDir, `${service.folder}.log`),
          PYTHONUNBUFFERED: "1",
        },
        stdio: ["ignore", log, log],
      });
    } finally { fs.closeSync(log); }
  }
  async function ensureStarted() {
    if (startup) return startup;
    startup = (async () => {
      const external = [];
      for (const service of services) {
        if (stopping) break;
        if (await checkHealth(service)) {
          if (!children.has(service.folder)) external.push(service.folder);
          continue;
        }
        if (!children.has(service.folder)) {
          const child = (spawnService || startService)(service);
          children.set(service.folder, child);
          child.once("exit", () => { if (children.get(service.folder) === child) children.delete(service.folder); });
          child.once("error", () => { if (children.get(service.folder) === child) children.delete(service.folder); });
        }
        let ready = false;
        for (let attempt = 0; attempt < 80 && !stopping; attempt++) {
          if (await checkHealth(service)) { ready = true; break; }
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (!ready) throw new Error(`${service.folder} did not start. Check local-data/logs/${service.folder}.log.`);
      }
      return {ok: true, dashboard: "http://127.0.0.1:8767/", external};
    })().finally(() => { startup = null; });
    return startup;
  }
  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    clearTimeout(idleTimer);
    server.close();
    for (const socket of clients) socket.destroy();
    shutdownPromise = (async () => {
      if (startup) await startup.catch(() => {});
      await Promise.all([...children.values()].map(stopService));
      try { await syncPending(); }
      catch (error) { fs.appendFileSync(path.join(logDir, "aws-sync.log"), `${new Date().toISOString()} ${error.message}\n`); }
    })();
    return shutdownPromise;
  }
  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (!stopping && !clients.size) idleTimer = setTimeout(shutdown, idleMs);
  }
  const server = net.createServer(socket => {
    if (stopping) { socket.destroy(); return; }
    clients.add(socket);
    clearTimeout(idleTimer);
    let input = "";
    socket.on("data", chunk => {
      input += chunk.toString("utf8");
      if (input.length > 4096) { socket.destroy(); return; }
      let end;
      while ((end = input.indexOf("\n")) >= 0) {
        const line = input.slice(0, end); input = input.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { socket.destroy(); return; }
        if (message.action !== "start") { socket.end(JSON.stringify({ok: false, error: "Only the start action is allowed."}) + "\n"); return; }
        ensureStarted().then(result => { if (!socket.destroyed) socket.write(JSON.stringify(result) + "\n"); })
          .catch(error => { if (!socket.destroyed) socket.write(JSON.stringify({ok: false, error: error.message}) + "\n"); });
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => { clients.delete(socket); scheduleIdle(); });
  });
  server.on("error", error => {
    if (error.code !== "EADDRINUSE") process.stderr.write(error.message + "\n");
    clearTimeout(idleTimer);
  });
  server.listen(pipe, scheduleIdle);
  return {server, shutdown, children, clients};
}

if (require.main === module) {
  const supervisor = runSupervisor();
  process.on("SIGTERM", () => supervisor.shutdown());
  process.on("SIGINT", () => supervisor.shutdown());
}
module.exports = {PIPE, ROOT, SERVICES, runSupervisor, health};
