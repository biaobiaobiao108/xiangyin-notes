const clientBuild = await Bun.build({
  entrypoints: ["./app/index.html"],
  outdir: "./dist/client",
  target: "browser",
  format: "esm",
  splitting: true,
  minify: true,
});
if (!clientBuild.success) throw new AggregateError(clientBuild.logs, "Client build failed");

const indexPath = "./dist/client/index.html";
let indexHtml = await Bun.file(indexPath).text();
indexHtml = indexHtml
  .replace(/href="[^"]*manifest(?:-[^"]+)?\.webmanifest"/, 'href="/manifest.webmanifest"')
  .replace(/href="[^"]*icon-192(?:-[^"]+)?\.png"/, 'href="/icon-192.png"');
await Bun.write(indexPath, indexHtml);

const workerBuild = await Bun.build({
  entrypoints: ["./app/sw.ts"],
  outdir: "./dist/client",
  target: "browser",
  format: "iife",
  minify: true,
});
if (!workerBuild.success) throw new AggregateError(workerBuild.logs, "Service worker build failed");
if (workerBuild.outputs.length !== 1) throw new Error("Service worker build did not produce exactly one output");
await Bun.write("./dist/client/sw.js", await workerBuild.outputs[0].arrayBuffer());

for (const file of ["manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png"]) {
  await Bun.write(`./dist/client/${file}`, Bun.file(`./app/${file}`));
}

export {};
