const processes = [
  Bun.spawn(["bun", "run", "dev:client"], { stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "--hot", "server/index.ts"], { stdout: "inherit", stderr: "inherit" }),
];

let shuttingDown = false;
const terminate = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of processes) child.kill();
};

process.on("SIGINT", terminate);
process.on("SIGTERM", terminate);
await Promise.race(processes.map((process) => process.exited));
terminate();

export {};
