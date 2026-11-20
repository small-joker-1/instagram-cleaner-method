#!/usr/bin/env node
import { analyzeExport } from "../src/export.mjs";

const LISTS = new Map([
  ["followers", "followers"],
  ["following", "following"],
  ["mutual", "mutual"],
  ["not-following-back", "notFollowingBack"],
  ["you-dont-follow-back", "youDontFollowBack"],
]);

function printUsage() {
  console.log(`Usage: instagram-export <export.zip | folder> [--list <name>]

Count followers, following, and the two one-way lists in an Instagram
data export. Everything is read on this computer.

--list prints one username per line. Names:
  followers
  following
  mutual
  not-following-back
  you-dont-follow-back

The same comparison on the web:
  https://instagramcleaner.com/
  https://instagramcleaner.com/instagram-data-export-guide
  https://instagramcleaner.com/blog/how-to-see-who-doesnt-follow-you-back-on-instagram`);
}

const args = process.argv.slice(2);

if (args.includes("-h") || args.includes("--help")) {
  printUsage();
  process.exit(0);
}

if (args.length === 0) {
  printUsage();
  process.exit(1);
}

const listFlag = args.indexOf("--list");
let listName = null;
if (listFlag !== -1) {
  listName = LISTS.get(args[listFlag + 1]);
  if (!listName) {
    console.error("Unknown --list. Use followers, following, mutual, not-following-back, or you-dont-follow-back.");
    process.exit(1);
  }
}

const target = args.find((arg, index) => arg !== "--list" && index !== listFlag + 1);
if (!target) {
  printUsage();
  process.exit(1);
}

try {
  const report = await analyzeExport(target);
  if (report.owner) console.log(`Account: ${report.owner}`);
  console.log(`Followers: ${report.followerCount}`);
  console.log(`Following: ${report.followingCount}`);
  console.log(`Mutual: ${report.mutual.length}`);
  console.log(`Not following you back: ${report.notFollowingBack.length}`);
  console.log(`You don't follow back: ${report.youDontFollowBack.length}`);
  if (listName) {
    console.log();
    for (const username of report[listName]) console.log(username);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
