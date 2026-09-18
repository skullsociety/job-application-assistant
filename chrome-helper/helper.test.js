"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const {EventEmitter, once} = require("node:events");
const {spawnSync} = require("node:child_process");
const {runSupervisor, ROOT} = require("./supervisor.js");
const {safeBatchPath, stableId} = require("./install.js");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function testPipe() { return `\\\\.\\pipe\\job-assistant-test-${process.pid}-${Math.random().toString(16).slice(2)}`; }
async function client(pipe) {
  const socket = net.createConnection(pipe); await once(socket, "connect"); return socket;
}
async function start(socket) {
  const reply = once(socket, "data"); socket.write('{"action":"start"}\n');
  return JSON.parse((await reply)[0].toString());
}

test("one owner starts once for several extensions; last disconnect stops its children", async () => {
  const pipe = testPipe(), running = new Set(), started = [], stopped = [];
  const supervisor = runSupervisor({pipe, idleMs: 40, services: [{folder: "one"}, {folder: "two"}],
    checkHealth: async service => running.has(service.folder),
    spawnService: service => {
      running.add(service.folder); started.push(service.folder);
      return Object.assign(new EventEmitter(), {pid: started.length, exitCode: null, folder: service.folder});
    },
    stopService: async child => { stopped.push(child.folder); child.emit("exit", 0); },
  });
  await once(supervisor.server, "listening");
  const one = await client(pipe), two = await client(pipe);
  try {
    const results = await Promise.all([start(one), start(two)]);
    assert.ok(results.every(result => result.ok));
    assert.deepEqual(started, ["one", "two"]);
    one.destroy(); await delay(80); assert.deepEqual(stopped, []);
    two.destroy(); await delay(100); assert.deepEqual(stopped.sort(), ["one", "two"]);
  } finally { one.destroy(); two.destroy(); await supervisor.shutdown(); }
});

test("a pre-existing server is reported but never killed", async () => {
  const pipe = testPipe(), stopped = [];
  const supervisor = runSupervisor({pipe, idleMs: 30, services: [{folder: "external"}],
    checkHealth: async () => true, spawnService: () => { throw Error("must not spawn"); }, stopService: child => stopped.push(child)});
  await once(supervisor.server, "listening");
  const socket = await client(pipe);
  try {
    assert.deepEqual((await start(socket)).external, ["external"]);
    socket.destroy(); await delay(100); assert.deepEqual(stopped, []);
  } finally { socket.destroy(); await supervisor.shutdown(); }
});

test("native messages cannot request arbitrary commands", () => {
  const body = Buffer.from('{"action":"delete","command":"anything"}');
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  const result = spawnSync(process.execPath, [path.join(__dirname, "native-host.js")], {input: Buffer.concat([header, body]), timeout: 5000});
  assert.equal(result.status, 1);
  const message = JSON.parse(result.stdout.subarray(4, 4 + result.stdout.readUInt32LE(0)));
  assert.equal(message.ok, false); assert.match(message.error, /only the start action/);
  assert.throws(() => safeBatchPath('C:\\bad%name'));
});

test("the unified extension leases the helper and releases it after the last browser window", async () => {
  for (const project of ["extension"]) {
    let windowCount = 1, connected = 0, disconnected = 0;
    const event = () => { const listeners = []; return {addListener: fn => listeners.push(fn), fire: (...args) => listeners.forEach(fn => fn(...args))}; };
    const onRemoved = event(), onCreated = event();
    const chrome = {windows: {getAll: async () => Array(windowCount).fill({}), onRemoved, onCreated},
      runtime: {onStartup: event(), onInstalled: event(), connectNative: name => {
        assert.equal(name, "com.job_application_assistant.launcher"); connected++;
        const port = {onMessage: event(), onDisconnect: event(),
          postMessage: () => queueMicrotask(() => port.onMessage.fire({ok: true})),
          disconnect: () => { disconnected++; port.onDisconnect.fire(); }};
        return port;
      }}};
    const context = {chrome, setTimeout, clearTimeout, console};
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, project, "native-lifecycle.js"), "utf8"), context);
    await delay(10); assert.equal(connected, 1);
    windowCount = 1; onRemoved.fire(1); await delay(10); assert.equal(disconnected, 0);
    windowCount = 0; onRemoved.fire(2); await delay(10); assert.equal(disconnected, 1);
    windowCount = 1; onCreated.fire({}); await delay(10); assert.equal(connected, 2);
    windowCount = 0; onRemoved.fire(3); await delay(10);
  }
});

test("one extension connects all source-specific capture ports to the shared dashboard", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "extension/manifest.json"), "utf8"));
  const workers = ["careersgov", "linkedin", "jobstreet"].map(site => fs.readFileSync(path.join(ROOT, "extension/sites", site, "worker.js"), "utf8"));
  for (const port of [8765, 8766, 8767]) assert.ok(workers.some(script => script.includes(`COMPANION_BASE = "http://127.0.0.1:${port}"`)));
  assert.ok(manifest.permissions.includes("nativeMessaging"));
  assert.ok(manifest.host_permissions.includes("http://127.0.0.1:8767/*"));
  assert.match(manifest.key, /^[A-Za-z0-9+/]+=*$/);
  assert.match(stableId(), /^[a-p]{32}$/);
});
