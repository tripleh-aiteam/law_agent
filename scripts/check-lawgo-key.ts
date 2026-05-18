/**
 * Quick sanity check for LAW_GO_KR_API_KEY.
 *
 * Usage:
 *   npm run check:lawgo
 *
 * Exits 0 when the key works, 1 when missing or unverified.
 */
import { checkApiKey, getMode } from "../src/lib/lawgo-client";

async function main(): Promise<void> {
  const mode = getMode();
  if (mode === "scrape") {
    console.log("❌ No LAW_GO_KR_API_KEY found in environment.");
    console.log("   Falling back to scrape mode (limited to ~200 cases at 1 req/s).");
    console.log("   To enable API mode:");
    console.log("     1. Register at https://open.law.go.kr");
    console.log("     2. Get your OC key and add it to .env.local as LAW_GO_KR_API_KEY=...");
    console.log("     3. Re-run: npm run check:lawgo");
    process.exit(1);
  }
  const ok = await checkApiKey();
  if (ok) {
    console.log("✅ API key works — ready for full ingest.");
    console.log("   Try a small smoke run:  npm run ingest:lawgo -- --limit 5 --dry-run");
    console.log("   Then a real run:        npm run ingest:lawgo -- --limit 500");
    process.exit(0);
  } else {
    console.log("❌ LAW_GO_KR_API_KEY is set but the probe call did not return data.");
    console.log("   Common causes:");
    console.log("     - The OC value is the email username before '@', not the full email.");
    console.log("     - The key is awaiting approval on open.law.go.kr.");
    console.log("     - Network / firewall blocking www.law.go.kr.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[check-lawgo-key] Fatal:", err);
  process.exit(1);
});
