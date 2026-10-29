import { cp, mkdir } from "node:fs/promises";
import { build } from "esbuild";

async function main(): Promise<void> {
  await mkdir("web/dist", { recursive: true });
  await build({
    entryPoints: ["web/src/main.ts"],
    bundle: true,
    outfile: "web/dist/app.js",
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "none",
  });
  await cp("web/index.html", "web/dist/index.html");
  await cp("web/styles.css", "web/dist/styles.css");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
