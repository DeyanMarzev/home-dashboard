import { describe, expect, it } from 'vitest';
import { keyBytes } from './push.js';

describe('keyBytes', () => {
  it('decodes a base64url VAPID key to its 65 bytes', () => {
    // A real P-256 public key: 0x04 then 64 bytes of coordinates.
    const key =
      'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
    const bytes = keyBytes(key);
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(4);
  });
});
