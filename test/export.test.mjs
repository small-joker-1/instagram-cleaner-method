import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

import {
  analyzeExport,
  cleanUsername,
  collectAccounts,
  loadExport,
  readOwnerUsername,
} from "../src/export.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const example = join(root, "examples/sample-export");

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
    const method = entry.method ?? 8;
    const flags = entry.flags ?? 0;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    const sizesKnown = (flags & 0x8) === 0;
    local.writeUInt32LE(sizesKnown ? compressed.length : 0, 18);
    local.writeUInt32LE(sizesKnown ? data.length : 0, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    const file = Buffer.concat([local, name, compressed]);
    locals.push(file);
    centrals.push(Buffer.concat([central, name]));
    offset += file.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

test("the sample export matches the counts in the readme", async () => {
  const loaded = await loadExport(example);
  assert.equal(loaded.owner, "sample.account");
  assert.equal(loaded.followers.get("grace"), 1700001000);

  const report = await analyzeExport(example);
  assert.equal(report.followerCount, 3);
  assert.equal(report.followingCount, 4);
  assert.deepEqual(report.mutual, ["grace", "linus"]);
  assert.deepEqual(report.notFollowingBack, ["barbara", "ken"]);
  assert.deepEqual(report.youDontFollowBack, ["ada"]);
});

test("a display name falls back to the instagram link", () => {
  const accounts = collectAccounts({
    title: "ken",
    string_list_data: [
      {
        href: "https://www.instagram.com/_u/barbara",
        value: "Barbara Liddell",
        timestamp: 10,
      },
    ],
  });
  assert.deepEqual([...accounts.keys()], ["barbara"]);
  assert.equal(cleanUsername("Not A Handle"), null);
  assert.equal(cleanUsername("@Ada"), "ada");
});

test("older label_values still yield the owner handle", () => {
  assert.equal(
    readOwnerUsername({
      label_values: [{ label: "Username", value: "sample.account" }],
    }),
    "sample.account",
  );
});

test("a zip ignores photos and html, and reads split follower files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "instagram-export-"));
  const zipPath = join(directory, "export.zip");
  try {
    const zip = buildZip([
      {
        name: "connections/followers_and_following/followers_1.json",
        data: JSON.stringify([
          { string_list_data: [{ value: "ada", timestamp: 1 }] },
        ]),
      },
      {
        name: "connections/followers_and_following/followers_2.json",
        data: JSON.stringify([
          { string_list_data: [{ value: "grace", timestamp: 2 }] },
        ]),
        method: 0,
        flags: 0x8,
      },
      {
        name: "connections/followers_and_following/following.json",
        data: JSON.stringify({
          relationships_following: [
            { string_list_data: [{ href: "https://www.instagram.com/grace", timestamp: 2 }] },
            { string_list_data: [{ value: "ken", timestamp: 3 }] },
          ],
        }),
      },
      {
        name: "media/posts.json",
        data: JSON.stringify([{ string_list_data: [{ value: "ignored" }] }]),
      },
      {
        name: "connections/followers_and_following/followers_1.html",
        data: "<a href=\"https://www.instagram.com/htmlonly\">html</a>",
        method: 0,
      },
      {
        name: "__MACOSX/._followers_1.json",
        data: JSON.stringify([{ string_list_data: [{ value: "appledouble" }] }]),
        method: 0,
      },
    ]);
    await writeFile(zipPath, zip);
    const report = await analyzeExport(zipPath);
    assert.deepEqual(report.followers, ["ada", "grace"]);
    assert.deepEqual(report.notFollowingBack, ["ken"]);
    assert.deepEqual(report.youDontFollowBack, ["ada"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an export with only one list names the missing file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "instagram-export-"));
  try {
    await writeFile(
      join(directory, "following.json"),
      JSON.stringify({ relationships_following: [] }),
    );
    await assert.rejects(() => analyzeExport(directory), /no followers JSON/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the command prints the sample report", () => {
  const result = spawnSync(
    process.execPath,
    [join(root, "bin/instagram-export.mjs"), example, "--list", "not-following-back"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    [
      "Account: sample.account",
      "Followers: 3",
      "Following: 4",
      "Mutual: 2",
      "Not following you back: 2",
      "You don't follow back: 1",
      "",
      "barbara",
      "ken",
      "",
    ].join("\n"),
  );
});
