const preview = Bun.spawn(["bun", "dist/server/index.js"], { stdout: "inherit", stderr: "inherit" });
process.exitCode = await preview.exited;

export {};
