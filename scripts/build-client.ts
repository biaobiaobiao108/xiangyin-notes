import { rm } from "node:fs/promises";
import { resolve } from "node:path";

await rm(resolve("./dist/client"), { recursive: true, force: true });
await rm(resolve("./dist/worker"), { recursive: true, force: true });

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
const workerSource = await workerBuild.outputs[0].text();
const cacheName = `xiangying-notes-shell-${Date.now().toString(36)}`;
await Bun.write("./dist/client/sw.js", workerSource.replaceAll("__XIANGYING_CACHE_NAME__", cacheName));

for (const file of ["manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png"]) {
  await Bun.write(`./dist/client/${file}`, Bun.file(`./app/${file}`));
}

const clientRoot = resolve("./dist/client");
for await (const generatedFile of new Bun.Glob("icon-192-*.png").scan({ cwd: clientRoot, onlyFiles: true })) {
  await rm(resolve(clientRoot, generatedFile), { force: true });
}
for await (const generatedFile of new Bun.Glob("manifest-*.webmanifest").scan({ cwd: clientRoot, onlyFiles: true })) {
  await rm(resolve(clientRoot, generatedFile), { force: true });
}

for await (const file of new Bun.Glob("**/*").scan({ cwd: clientRoot, onlyFiles: true })) {
  if (!/\.(?:css|html|js|json|webmanifest)$/u.test(file) || file.endsWith(".gz")) continue;
  const sourcePath = resolve(clientRoot, file);
  const compressed = Bun.gzipSync(new Uint8Array(await Bun.file(sourcePath).arrayBuffer()));
  await Bun.write(`${sourcePath}.gz`, compressed);
}

export {};
