// Helpers shared by the Worker (server) and the Node admin scripts.
// Uses only Web Crypto, which both environments provide.

// 32 characters, no look-alikes: no 0/O, no 1/I. Codes are upper-case only, so there is no
// lower-case l either. (Upper-case L is kept: it doesn't resemble 1 or I.)
export const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 32 chars -> 5 bits each
export const CODE_LENGTH = 15; // 75 bits of randomness

// Random code using rejection sampling (no bias for any alphabet size).
export function generateCode() {
  const n = CODE_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = "";
  while (out.length < CODE_LENGTH) {
    const buf = crypto.getRandomValues(new Uint8Array(32));
    for (const b of buf) {
      if (b < limit && out.length < CODE_LENGTH) out += CODE_ALPHABET[b % n];
    }
  }
  return out;
}

// Display form: K7QMX-R4PWZ-9HTNB
export function formatCode(code) {
  return code.match(/.{1,5}/g).join("-");
}

// Normalise a code the way a person might type it: ignore spaces/dashes, accept lower case.
export function normalizeCode(input) {
  return String(input ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
}

// The one product. Used by get_product now and by Stripe Checkout in Step 5.
export const PRODUCT = {
  name: "The PDF Supplier: one PDF",
  unitAmountCents: 100,
  currency: "usd",
  priceLabel: "$1.00 USD",
  contents: "You now own this PDF.",
};

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Hash used for sign-in codes. Prefixed so a code hash can never collide with another kind of hash.
export function hashCode(code) {
  return sha256Hex(`pdfs-code:${normalizeCode(code)}`);
}
