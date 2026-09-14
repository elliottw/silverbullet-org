import { expect, test } from "vitest";
import { md5Hex } from "./md5.ts";

const enc = (s: string) => new TextEncoder().encode(s);

test("RFC 1321 test vectors", () => {
  expect(md5Hex(enc(""))).toEqual("d41d8cd98f00b204e9800998ecf8427e");
  expect(md5Hex(enc("a"))).toEqual("0cc175b9c0f1b6a831c399e269772661");
  expect(md5Hex(enc("abc"))).toEqual("900150983cd24fb0d6963f7d28e17f72");
  expect(md5Hex(enc("message digest"))).toEqual("f96b697d7cb7938d525a2f31aaf161d0");
  expect(
    md5Hex(enc("12345678901234567890123456789012345678901234567890123456789012345678901234567890")),
  ).toEqual("57edf4a22be3c955ac49da2e2107b67a");
});

test("Binary input longer than one block", () => {
  const bytes = new Uint8Array(1000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
  // Cross-checked with `python3 -c "import hashlib;print(hashlib.md5(bytes(i&255 for i in range(1000))).hexdigest())"`.
  expect(md5Hex(bytes)).toEqual("cbecbdb0fdd5cec1e242493b6008cc79");
});
