// Rotates boxinventory's ACTIVE key using the OWNER key (piped via stdin).
// Generates a fresh keypair, pushes updateauth signed by owner, and saves the
// new active private key to .active-key.local (gitignored) for upload to Cloudflare.
//
// Usage:  pbpaste | node rotate-active.js     (owner key on the clipboard)

const fs = require("fs");
const { Api, JsonRpc } = require("eosjs");
const { JsSignatureProvider } = require("eosjs/dist/eosjs-jssig");
const kc = require("eosjs/dist/eosjs-key-conversions");
const numeric = require("eosjs/dist/eosjs-numeric");

const ACCOUNT = "boxinventory";
const EXPECTED_OWNER = "EOS6QY2Rwcuj4srsFf2q8vcEDYgJeHXusykbgLqTTeCVHiBGjvFaa";
const RPC = "https://wax.greymass.com";
const OUT_FILE = __dirname + "/.active-key.local";

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", async () => {
  const ownerKey = input.trim();
  const toLegacy = (pub) =>
    numeric.publicKeyToLegacyString(numeric.stringToPublicKey(pub.toString()));

  let ownerPub;
  try {
    ownerPub = toLegacy(kc.PrivateKey.fromString(ownerKey).getPublicKey());
  } catch (e) {
    console.log("That is not a valid private key (" + e.message + ")");
    process.exit(1);
  }
  if (ownerPub !== EXPECTED_OWNER) {
    console.log("❌ This is not the boxinventory OWNER key (derives " + ownerPub + "). Aborting — nothing was changed.");
    process.exit(1);
  }
  console.log("✅ Owner key verified. Generating a new active keypair…");

  const kp = kc.generateKeyPair(numeric.KeyType.k1, { secureEnv: true });
  const newPub = toLegacy(kp.publicKey);
  const newPriv = kp.privateKey.toLegacyString();

  const api = new Api({
    rpc: new JsonRpc(RPC, { fetch }),
    signatureProvider: new JsSignatureProvider([ownerKey]),
  });

  try {
    const result = await api.transact(
      {
        actions: [
          {
            account: "eosio",
            name: "updateauth",
            authorization: [{ actor: ACCOUNT, permission: "owner" }],
            data: {
              account: ACCOUNT,
              permission: "active",
              parent: "owner",
              auth: { threshold: 1, keys: [{ key: newPub, weight: 1 }], accounts: [], waits: [] },
            },
          },
        ],
      },
      { blocksBehind: 3, expireSeconds: 30 }
    );
    fs.writeFileSync(OUT_FILE, newPriv + "\n", { mode: 0o600 });
    console.log("✅ Active key rotated on-chain. tx: " + result.transaction_id);
    console.log("   New active public key: " + newPub);
    console.log("   New active PRIVATE key saved to worker/.active-key.local");
    console.log("   Next: tell Claude it's done — the new key gets uploaded to Cloudflare from that file.");
  } catch (e) {
    console.log("❌ updateauth failed: " + (e.message || e));
    process.exit(1);
  }
});
