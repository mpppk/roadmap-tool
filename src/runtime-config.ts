export function getPort(): number {
  const rawPort = process.env.PORT;
  if (rawPort === undefined || rawPort === "") return 3000;

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${rawPort}`);
  }
  return port;
}

export function getLocalBaseUrl(port = getPort()): string {
  return `http://localhost:${port}`;
}
