// Reports which build is loaded. The extension has no build step, so when it
// is loaded unpacked from a git checkout we read the repository metadata that
// sits inside the extension folder: .git/HEAD -> branch and commit hash, the
// loose commit object -> commit date, and .git/logs/HEAD -> checkout time.

async function readText(path) {
  const res = await fetch(chrome.runtime.getURL(path));
  if (!res.ok) throw new Error(`missing ${path}`);
  return res.text();
}

async function readCommitDate(hash) {
  const res = await fetch(chrome.runtime.getURL(`.git/objects/${hash.slice(0, 2)}/${hash.slice(2)}`));
  if (!res.ok || typeof DecompressionStream === "undefined") return null;
  const stream = res.body.pipeThrough(new DecompressionStream("deflate"));
  const text = await new Response(stream).text();
  const m = text.match(/\ncommitter [^\n]*? (\d{9,11}) ([+-]\d{4})\n/);
  return m ? new Date(Number(m[1]) * 1000).toISOString() : null;
}

async function readCheckoutDate() {
  try {
    const log = await readText(".git/logs/HEAD");
    const last = log.trim().split("\n").pop() || "";
    const m = last.match(/> (\d{9,11}) ([+-]\d{4})\t/);
    return m ? new Date(Number(m[1]) * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

export async function getBuildInfo() {
  const manifest = chrome.runtime.getManifest();
  const info = { version: manifest.version, branch: null, hash: null, shortHash: null, commitDate: null, checkoutDate: null, source: "package" };
  let head;
  try {
    head = (await readText(".git/HEAD")).trim();
  } catch {
    return info; // installed from a zip or store package: no git metadata
  }
  info.source = "git";
  let hash = null;
  if (head.startsWith("ref: ")) {
    const ref = head.slice(5).trim();
    info.branch = ref.replace(/^refs\/heads\//, "");
    try {
      hash = (await readText(`.git/${ref}`)).trim();
    } catch {
      try {
        const packed = await readText(".git/packed-refs");
        const line = packed.split("\n").find((l) => l.endsWith(` ${ref}`));
        hash = line ? line.split(" ")[0] : null;
      } catch {
        hash = null;
      }
    }
  } else if (/^[0-9a-f]{40}$/.test(head)) {
    hash = head; // detached HEAD
  }
  if (hash) {
    info.hash = hash;
    info.shortHash = hash.slice(0, 7);
    try {
      info.commitDate = await readCommitDate(hash);
    } catch {
      info.commitDate = null;
    }
  }
  info.checkoutDate = await readCheckoutDate();
  return info;
}

export function formatBuildInfo(info) {
  const fmt = (iso) => {
    const d = new Date(iso);
    return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  };
  const bits = [`v${info.version}`];
  if (info.shortHash) bits.push(`commit ${info.shortHash}`);
  if (info.branch) bits.push(info.branch);
  if (info.commitDate) bits.push(`committed ${fmt(info.commitDate)}`);
  else if (info.checkoutDate) bits.push(`checked out ${fmt(info.checkoutDate)}`);
  if (info.source === "package") bits.push("no git metadata in this package");
  return bits.join(" · ");
}
