"use strict";
// Manual BAT shortcuts use exactly the same supervisor as Chrome.
const {connectSupervisor} = require("./native-host.js");
connectSupervisor().then(socket => {
  socket.on("error", error => { console.error(error.message); process.exitCode = 1; });
  let input = "";
  socket.on("data", chunk => {
    input += chunk;
    if (!input.includes("\n")) return;
    const status = JSON.parse(input.split("\n")[0]);
    console.log(status.ok ? "Assistants ready. Keep Chrome open with a job-assistant extension enabled." : status.error);
    if (!status.ok) process.exitCode = 1;
    socket.end();
  });
  socket.write('{"action":"start"}\n');
}).catch(error => { console.error(error.message); process.exitCode = 1; });
