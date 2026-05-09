import { tmpdir } from "node:os";
import { join } from "node:path";
import { version } from "../package.json";

const GITHUB_API_URL =
  "https://api.github.com/repos/mpppk/roadmap-tool/releases/latest";

type ReleaseAsset = { name: string; browser_download_url: string };
type GithubRelease = { tag_name: string; assets: ReleaseAsset[] };

function getAssetName(): string {
  const { platform, arch } = process;
  if (platform === "linux" && arch === "x64")
    return "roadmap-tool_Linux_x86_64.tar.gz";
  if (platform === "linux" && arch === "arm64")
    return "roadmap-tool_Linux_arm64.tar.gz";
  if (platform === "darwin" && arch === "arm64")
    return "roadmap-tool_Darwin_arm64.tar.gz";
  if (platform === "darwin" && arch === "x64")
    return "roadmap-tool_Darwin_x86_64.tar.gz";
  if (platform === "win32" && arch === "x64")
    return "roadmap-tool_Windows_x86_64.zip";
  throw new Error(`Unsupported platform/arch: ${platform}/${arch}`);
}

function isNewerVersion(latest: string, current: string): boolean {
  const parts = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [lMaj, lMin, lPat = 0] = parts(latest);
  const [cMaj, cMin, cPat = 0] = parts(current);
  if (lMaj !== cMaj) return (lMaj ?? 0) > (cMaj ?? 0);
  if (lMin !== cMin) return (lMin ?? 0) > (cMin ?? 0);
  return lPat > cPat;
}

function parseChecksums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf("  ");
    if (spaceIdx === -1) continue;
    map.set(trimmed.slice(spaceIdx + 2), trimmed.slice(0, spaceIdx));
  }
  return map;
}

async function fetchRelease(): Promise<GithubRelease> {
  const resp = await fetch(GITHUB_API_URL, {
    headers: {
      "User-Agent": "roadmap-tool-updater",
      Accept: "application/vnd.github+json",
    },
  });
  if (!resp.ok)
    throw new Error(`GitHub API error: ${resp.status} ${resp.statusText}`);
  return resp.json() as Promise<GithubRelease>;
}

async function downloadAsset(url: string): Promise<ArrayBuffer> {
  const resp = await fetch(url, {
    headers: { "User-Agent": "roadmap-tool-updater" },
  });
  if (!resp.ok)
    throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
  return resp.arrayBuffer();
}

export async function runUpdate(checkOnly: boolean): Promise<void> {
  process.stdout.write("Checking for updates... ");
  const release = await fetchRelease();
  const latestTag = release.tag_name;

  if (!isNewerVersion(latestTag, version)) {
    console.log(`already up to date (${version}).`);
    return;
  }

  console.log(`new version available: ${latestTag} (current: v${version})`);

  if (checkOnly) return;

  const execPath = process.execPath;

  // Guard against overwriting the Bun runtime when running from source
  if (execPath.endsWith("/bun") || execPath.endsWith("\\bun.exe")) {
    throw new Error(
      "Self-update is only supported when running as a compiled binary, not via `bun src/...`",
    );
  }

  const assetName = getAssetName();
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset)
    throw new Error(`No release asset found for platform: ${assetName}`);

  const checksumAsset = release.assets.find((a) => a.name === "checksums.txt");
  if (!checksumAsset) throw new Error("No checksums.txt found in release");

  console.log(`Downloading ${assetName}...`);
  const [archiveData, checksumData] = await Promise.all([
    downloadAsset(asset.browser_download_url),
    downloadAsset(checksumAsset.browser_download_url),
  ]);

  const checksums = parseChecksums(new TextDecoder().decode(checksumData));
  const expected = checksums.get(assetName);
  if (!expected)
    throw new Error(`No checksum entry for ${assetName} in checksums.txt`);

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(archiveData);
  const actual = hasher.digest("hex");
  if (actual !== expected) {
    throw new Error(
      `Checksum mismatch for ${assetName}: expected ${expected}, got ${actual}`,
    );
  }
  console.log("Checksum verified.");

  const workDir = join(tmpdir(), `roadmap-tool-update-${Date.now()}`);
  try {
    const extractDir = join(workDir, "extract");
    await Bun.$`mkdir -p ${extractDir}`.quiet();

    const archivePath = join(workDir, assetName);
    await Bun.write(archivePath, archiveData);

    if (assetName.endsWith(".tar.gz")) {
      await Bun.$`tar -xzf ${archivePath} -C ${extractDir}`.quiet();
    } else {
      // .zip on Windows: use built-in tar (Windows 10+ supports zip via bsdtar)
      await Bun.$`tar -xf ${archivePath} -C ${extractDir}`.quiet();
    }

    const binaryName =
      process.platform === "win32" ? "roadmap-tool.exe" : "roadmap-tool";
    const extractedBin = join(extractDir, binaryName);
    const newBinPath = `${execPath}.new`;

    await Bun.write(newBinPath, Bun.file(extractedBin));

    try {
      if (process.platform === "win32") {
        // Windows cannot overwrite a running exe; rename it first (rename is allowed
        // even for in-use files on NTFS), then move the new binary into its place.
        // newBinPath is ${execPath}.new — same volume, so rename is atomic.
        const { rename: fsRename, unlink } = await import("node:fs/promises");
        const oldBinPath = `${execPath}.old`;
        try {
          await unlink(oldBinPath);
        } catch {}
        await fsRename(execPath, oldBinPath);
        await fsRename(newBinPath, execPath);
      } else {
        await Bun.$`chmod +x ${newBinPath}`.quiet();
        await Bun.$`mv ${newBinPath} ${execPath}`.quiet();
      }
    } catch (err) {
      // Clean up .new file on failure
      await Bun.$`rm -f ${newBinPath}`.quiet().nothrow();
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("Permission denied") ||
        msg.includes("EACCES") ||
        msg.includes("EPERM") ||
        msg.includes("Access is denied")
      ) {
        throw new Error(
          `Permission denied replacing ${execPath}.\n` +
            (process.platform === "win32"
              ? "Try running as Administrator."
              : `Try: sudo roadmap-tool update`),
        );
      }
      throw err;
    }
  } finally {
    await Bun.$`rm -rf ${workDir}`.quiet().nothrow();
  }

  console.log(
    `Successfully updated to ${latestTag}. Run 'roadmap-tool --version' to confirm.`,
  );
}
