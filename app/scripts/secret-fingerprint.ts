// Compare a secret across environments without ever seeing it.
//
//   npx tsx scripts/secret-fingerprint.ts STRIPE_WEBHOOK_SECRET
//
// WHY A FINGERPRINT
// "Is the local webhook secret the same one the deployment uses?" is a
// question that normally gets answered by printing both and looking. That
// puts a live credential into a terminal, a scrollback buffer and, if
// anybody pastes it, a chat log.
//
// A salted SHA-256 truncated to twelve hex characters answers the same
// question and reveals nothing: two environments holding the same value
// produce the same fingerprint, and the fingerprint cannot be turned back
// into the value. The salt is a constant in this file rather than a random
// one precisely so the fingerprint is COMPARABLE across machines — it is not
// a password hash and is not trying to be.
//
// Output is deliberately one of: missing, configured, or a fingerprint.
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();
import { createHash } from 'node:crypto';

// Not a security boundary. It exists so a fingerprint printed here cannot be
// looked up in a rainbow table of common secrets, while staying identical
// wherever this script runs.
const SALT = 'towconnect-secret-fingerprint-v1';

export function fingerprint(value: string): string {
  return createHash('sha256').update(SALT).update(value).digest('hex').slice(0, 12);
}

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error('Usage: npx tsx scripts/secret-fingerprint.ts <ENV_VAR> [ENV_VAR ...]');
  process.exit(1);
}

for (const name of names) {
  const value = process.env[name];
  if (!value) {
    console.log(`${name}: missing`);
    continue;
  }
  // The prefix is not a secret — Stripe documents it, and knowing a key is a
  // test key rather than a live one is exactly the kind of thing this whole
  // project keeps wanting to assert out loud.
  const prefix = value.match(/^(sk_test_|sk_live_|rk_test_|rk_live_|whsec_|pk_test_|pk_live_|eyJ)/)?.[1] ?? '';
  console.log(
    `${name}: configured  prefix=${prefix || '(none)'}  length=${value.length}  fingerprint=${fingerprint(value)}`
  );
}
