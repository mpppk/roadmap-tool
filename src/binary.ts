#!/usr/bin/env bun

async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];

  try {
    const subprocess = Bun.spawn(command, {
      stdout: "ignore",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stderr).text(),
    ]);
    if (exitCode !== 0) {
      console.error(
        `Failed to open browser automatically. Open this URL manually: ${url}`,
      );
      if (stderr.trim()) console.error(stderr.trim());
    }
  } catch (error) {
    console.error(
      `Failed to open browser automatically. Open this URL manually: ${url}`,
    );
    console.error(error instanceof Error ? error.message : error);
  }
}

const args = process.argv.slice(2);

if (args.length > 0) {
  const { handleCliError, runCli } = await import("./cli");
  await runCli(args, "roadmap-tool").catch(handleCliError);
} else {
  try {
    const { startServer } = await import("./server");
    const server = await startServer();
    await openBrowser(server.url.href);
  } catch (error) {
    console.error(
      `Failed to start server: ${error instanceof Error ? error.message : error}`,
    );
    process.exit(1);
  }
}
