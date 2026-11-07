import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';

export const TEAM = 'myteam';
export const ISSUER = `https://${TEAM}.cloudflareaccess.com`;
export const AUDIENCE = 'test-audience-tag';

/** A stand-in for Cloudflare Access: signs tokens and exposes the matching JWKS. */
export async function fakeAccess(): Promise<{
  keys: JWTVerifyGetKey;
  sign: (
    claims?: JWTPayload,
    opts?: { issuer?: string; audience?: string; expiresAt?: number },
  ) => Promise<string>;
  signWithUnknownKey: () => Promise<string>;
}> {
  const kid = 'test-key';
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' }],
  });

  const build = (claims: JWTPayload, issuer: string, audience: string, expiresAt: number) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(issuer)
      .setAudience([audience])
      .setSubject('user-123')
      .setIssuedAt()
      .setExpirationTime(expiresAt);

  const inFiveMinutes = () => Math.floor(Date.now() / 1000) + 300;

  return {
    keys,
    sign: (claims = { email: 'owner@example.com' }, opts = {}) =>
      build(
        claims,
        opts.issuer ?? ISSUER,
        opts.audience ?? AUDIENCE,
        opts.expiresAt ?? inFiveMinutes(),
      ).sign(privateKey),
    signWithUnknownKey: () =>
      build({ email: 'owner@example.com' }, ISSUER, AUDIENCE, inFiveMinutes()).sign(
        other.privateKey,
      ),
  };
}
