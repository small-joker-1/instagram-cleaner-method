import { inflateRawSync } from "node:zlib";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const USERNAME = /^[a-z0-9._]{1,30}$/;
const MAX_ZIP_BYTES = 300 * 1024 * 1024;
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;

export function cleanUsername(value) {
  if (typeof value !== "string") return null;
  const username = value.trim().replace(/^@/, "").toLowerCase();
  return USERNAME.test(username) ? username : null;
}

function usernameFromHref(href) {
  if (typeof href !== "string" || href.length === 0) return null;
  let url;
  try {
    url = new URL(href, "https://www.instagram.com");
  } catch {
    return null;
  }
  if (!url.hostname.endsWith("instagram.com")) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const handle = parts[0] === "_u" ? parts[1] : parts[0];
  return cleanUsername(handle);
}

function readTimestamp(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

function earlier(current, next) {
  if (current == null) return next;
  if (next == null) return current;
  return Math.min(current, next);
}

/**
 * Collect Instagram relationship rows from one JSON document.
 *
 * Current exports store each account in `string_list_data[].value`. Some older
 * files put the handle in the link, or in `title` when `value` is a display name.
 * A repeated handle keeps the earliest timestamp.
 */
export function collectAccounts(value, accounts = new Map()) {
  if (Array.isArray(value)) {
    for (const item of value) collectAccounts(item, accounts);
    return accounts;
  }
  if (!value || typeof value !== "object") return accounts;

  const list = value.string_list_data;
  if (Array.isArray(list)) {
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const username =
        cleanUsername(item.value) ||
        usernameFromHref(item.href) ||
        cleanUsername(value.title);
      if (!username) continue;
      accounts.set(username, earlier(accounts.get(username), readTimestamp(item.timestamp)));
    }
  }

  for (const child of Object.values(value)) collectAccounts(child, accounts);
  return accounts;
}

/** The account that owns the export, when `personal_information.json` is present. */
export function readOwnerUsername(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = readOwnerUsername(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;

  const map = value.string_map_data;
  if (map && typeof map === "object" && !Array.isArray(map)) {
    const username = cleanUsername(map.Username?.value);
    if (username) return username;
  }

  if (Array.isArray(value.label_values)) {
    const match = value.label_values.find((item) => item && item.label === "Username");
    const username = cleanUsername(match?.value);
    if (username) return username;
  }

  for (const child of Object.values(value)) {
    const found = readOwnerUsername(child);
    if (found) return found;
  }
  return null;
}

export function relationshipKind(filePath) {
  const parts = String(filePath).split(/[/\\]/);
  if (parts.some((part) => part === "__MACOSX" || part.startsWith("._"))) return null;
  const name = (parts.at(-1) ?? "").toLowerCase();
  if (/^followers(?:_\d+)?\.json$/.test(name)) return "followers";
  if (name === "following.json") return "following";
  if (name === "personal_information.json") return "owner";
  return null;
}

function emptyCollection() {
  return {
    owner: null,
    followers: new Map(),
    following: new Map(),
    followerFiles: 0,
    followingFiles: 0,
  };
}

function parseJson(text, name) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name} is not valid JSON.`);
  }
}

function addAccounts(target, found) {
  for (const [username, timestamp] of found) {
    target.set(username, earlier(target.get(username), timestamp));
  }
}

function addDocument(collected, kind, text, name) {
  const json = parseJson(text, name);
  if (kind === "owner") {
    collected.owner ??= readOwnerUsername(json);
    return;
  }
  const found = collectAccounts(json);
  if (kind === "followers") {
    collected.followerFiles += 1;
    addAccounts(collected.followers, found);
    return;
  }
  collected.followingFiles += 1;
  addAccounts(collected.following, found);
}

function missingListsMessage(collected) {
  if (collected.followerFiles === 0 && collected.followingFiles === 0) {
    return "No followers or following JSON files were found. Request Followers and following from Instagram, in JSON, or pass the extracted folder.";
  }
  if (collected.followerFiles === 0) {
    return "This export has following.json but no followers JSON. Numbered files such as followers_1.json count. Both lists are required.";
  }
  return "This export has followers JSON but no following.json. Both lists are required.";
}

export function summarize(collected) {
  if (collected.followerFiles === 0 || collected.followingFiles === 0) {
    throw new Error(missingListsMessage(collected));
  }

  const mutual = [];
  const notFollowingBack = [];
  const youDontFollowBack = [];

  for (const username of collected.following.keys()) {
    if (collected.followers.has(username)) mutual.push(username);
    else notFollowingBack.push(username);
  }
  for (const username of collected.followers.keys()) {
    if (!collected.following.has(username)) youDontFollowBack.push(username);
  }

  const byName = (left, right) => left.localeCompare(right);
  return {
    owner: collected.owner,
    followerCount: collected.followers.size,
    followingCount: collected.following.size,
    followers: [...collected.followers.keys()].sort(byName),
    following: [...collected.following.keys()].sort(byName),
    mutual: mutual.sort(byName),
    notFollowingBack: notFollowingBack.sort(byName),
    youDontFollowBack: youDontFollowBack.sort(byName),
  };
}

function findEocd(bytes) {
  const min = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= min; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = bytes.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === bytes.length) return offset;
  }
  throw new Error("This file is not a ZIP archive.");
}

function listZipEntries(bytes) {
  const eocd = findEocd(bytes);
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const directoryOffset = bytes.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || directoryOffset === 0xffffffff) {
    throw new Error(
      "This ZIP uses ZIP64. Request only Followers and following, or pass the extracted folder.",
    );
  }

  const entries = [];
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("The ZIP central directory could not be read.");
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    if (localOffset === 0xffffffff || compressedSize === 0xffffffff) {
      throw new Error(
        "This ZIP uses ZIP64. Request only Followers and following, or pass the extracted folder.",
      );
    }
    const nameStart = offset + 46;
    const name = bytes.subarray(nameStart, nameStart + nameLength).toString("utf8");
    entries.push({
      name,
      flags,
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

function unzipEntry(bytes, entry) {
  if (entry.flags & 0x1) {
    throw new Error(`${entry.name} is encrypted. An Instagram export ZIP is not password-protected.`);
  }
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
    throw new Error(`${entry.name} is too large. Request only Followers and following.`);
  }
  if (entry.localOffset + 30 > bytes.length || bytes.readUInt32LE(entry.localOffset) !== 0x04034b50) {
    throw new Error(`The ZIP entry ${entry.name} could not be read.`);
  }
  const nameLength = bytes.readUInt16LE(entry.localOffset + 26);
  const extraLength = bytes.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw new Error(`The ZIP entry ${entry.name} is truncated.`);
  const compressed = bytes.subarray(start, end);
  if (entry.method === 0) return compressed.toString("utf8");
  if (entry.method === 8) return inflateRawSync(compressed).toString("utf8");
  throw new Error(
    `${entry.name} uses ZIP compression method ${entry.method}, which this tool does not read. Unzip the export and pass the folder.`,
  );
}

function readZip(bytes) {
  const collected = emptyCollection();
  for (const entry of listZipEntries(bytes)) {
    if (entry.name.endsWith("/")) continue;
    const kind = relationshipKind(entry.name);
    if (!kind) continue;
    addDocument(collected, kind, unzipEntry(bytes, entry), entry.name);
  }
  return collected;
}

async function readDirectory(directory) {
  const collected = emptyCollection();
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parent = entry.parentPath ?? entry.path ?? directory;
    const filePath = join(parent, entry.name);
    const kind = relationshipKind(filePath);
    if (!kind) continue;
    const info = await stat(filePath);
    if (info.size > MAX_ENTRY_BYTES) {
      throw new Error(`${entry.name} is too large. Request only Followers and following.`);
    }
    addDocument(collected, kind, await readFile(filePath, "utf8"), entry.name);
  }
  return collected;
}

export async function loadExport(targetPath) {
  let info;
  try {
    info = await stat(targetPath);
  } catch {
    throw new Error(`Could not read ${targetPath}.`);
  }

  if (info.isDirectory()) return readDirectory(targetPath);
  if (!info.isFile()) throw new Error("Pass an export ZIP or the folder that contains the JSON files.");
  if (info.size > MAX_ZIP_BYTES) {
    throw new Error(
      "This ZIP is too large to open here. Request only Followers and following, or pass the extracted folder.",
    );
  }

  const bytes = await readFile(targetPath);
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) return readZip(bytes);
  throw new Error("Pass an Instagram export ZIP, or a folder that contains the followers and following JSON files.");
}

export async function analyzeExport(targetPath) {
  return summarize(await loadExport(targetPath));
}
