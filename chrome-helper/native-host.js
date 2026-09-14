"use strict";
const net = require("node:net");
const path = require("node:path");
const {spawn} = require("node:child_process");
const {PIPE, ROOT} = require("./supervisor.js");

function connect() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(PIPE);
    socket.once("connect", () => { socket.removeListener("error", reject); resolve(socket); });
    socket.once("error", reject);
  });
}

async function connectSupervisor() {
  try { return await connect(); } catch {}
  const child = spawn(process.execPath, [path.join(__dirname, "supervisor.js")], {
    cwd: ROOT, detached: true, windowsHide: true, stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try { return await connect(); } catch {}
  }
  throw new Error("The shared local helper did not start.");
}

function send(message) {
  const payload = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
  process.stdout.write(Buffer.concat([header, payload]));
}

function runNative() {
  let input = Buffer.alloc(0);
  let socket;
  let pending;
  let ended = false;
  function close() { ended = true; socket?.destroy(); }
  process.stdin.on("end", close);
  process.stdin.on("error", close);
  process.stdout.on("error", close);
  async function start(message) {
    if (message?.action !== "start") {
      send({ok: false, error: "The native helper accepts only the start action."});
      process.exitCode = 1; close(); process.stdin.destroy(); return;
    }
    if (!socket) {
      pending ||= connectSupervisor();
      const connected = await pending;
      if (ended) { connected.destroy(); return; }
      if (!socket) {
        socket = connected;
        let response = "";
        socket.on("data", chunk => {
          response += chunk.toString("utf8");
          let end;
          while ((end = response.indexOf("\n")) >= 0) {
            const line = response.slice(0, end); response = response.slice(end + 1);
            try { send(JSON.parse(line)); } catch { close(); }
          }
        });
        socket.on("error", () => { send({ok: false, error: "The shared helper disconnected."}); close(); process.stdin.destroy(); });
        socket.on("close", () => { process.stdin.destroy(); });
      }
    }
    socket.write('{"action":"start"}\n');
  }
  process.stdin.on("data", chunk => {
    input = Buffer.concat([input, chunk]);
    while (input.length >= 4) {
      const size = input.readUInt32LE(0);
      if (size < 2 || size > 4096) { send({ok: false, error: "Invalid native message size."}); close(); process.stdin.destroy(); return; }
      if (input.length < size + 4) return;
      const body = input.subarray(4, size + 4); input = input.subarray(size + 4);
      try { start(JSON.parse(body.toString("utf8"))).catch(error => send({ok: false, error: error.message})); }
      catch { send({ok: false, error: "Malformed native message."}); close(); process.stdin.destroy(); }
    }
  });
}
if (require.main === module) runNative();
module.exports = {connectSupervisor, runNative};
