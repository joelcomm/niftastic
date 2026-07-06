// Checks whether a private key (piped via stdin) matches boxinventory's active key.
// Usage:  pbpaste | node check-key.js     (copy the key to the clipboard first)
const EXPECTED_ACTIVE = "EOS8AjXxPKia65eL4BddYzVFbhGLw7xtgEQ2yEtq2GJrmKcRq3MA1";
const EXPECTED_OWNER = "EOS6QY2Rwcuj4srsFf2q8vcEDYgJeHXusykbgLqTTeCVHiBGjvFaa";

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const key = input.trim();
  if (!key) { console.log("No key received — copy it to the clipboard, then run: pbpaste | node check-key.js"); process.exit(1); }
  let pub;
  try {
    const kc = require("eosjs/dist/eosjs-key-conversions");
    const numeric = require("eosjs/dist/eosjs-numeric");
    const pubKey = kc.PrivateKey.fromString(key).getPublicKey();
    pub = numeric.publicKeyToLegacyString(numeric.stringToPublicKey(pubKey.toString()));
  } catch (e) {
    console.log("That is not a valid private key (" + e.message + ")");
    process.exit(1);
  }
  if (pub === EXPECTED_ACTIVE) console.log("✅ MATCH — this is boxinventory's ACTIVE key. Safe to upload.");
  else if (pub === EXPECTED_OWNER) console.log("✅ MATCH — this is boxinventory's OWNER key (works too, but prefer the active key).");
  else console.log("❌ NO MATCH — this key derives " + pub + "\nExpected active: " + EXPECTED_ACTIVE);
});
