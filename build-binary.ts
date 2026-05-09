import tailwind from "bun-plugin-tailwind";

// BUN_TARGET allows cross-compilation (e.g. "bun-linux-arm64" from an x64 host)
const target = (Bun.env.BUN_TARGET ?? "bun") as Parameters<
  typeof Bun.build
>[0]["target"];

const result = await Bun.build({
  entrypoints: ["./src/binary.ts"],
  target,
  compile: {
    outfile: "./roadmap-tool",
  },
  plugins: [tailwind],
  minify: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

const size = (result.outputs[0]?.size ?? 0) / 1024 / 1024;
console.log(`Built: roadmap-tool  ${size.toFixed(1)} MB`);
