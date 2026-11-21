import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, normaliseAccessTeam } from './config.js';

const access = {
  CF_ACCESS_TEAM: 'myteam',
  CF_ACCESS_AUD: 'aud-tag',
  ADMIN_EMAILS: 'owner@example.com',
  VAPID_PUBLIC_KEY: `B${'A'.repeat(86)}`,
  VAPID_PRIVATE_KEY: 'a'.repeat(43),
  VAPID_SUBJECT: 'mailto:owner@example.com',
};

describe('loadConfig', () => {
  it('builds the Access issuer and certs URL from the team name', () => {
    const config = loadConfig({ NODE_ENV: 'production', ...access });
    expect(config.auth).toEqual({
      disabled: false,
      team: 'myteam',
      audience: 'aud-tag',
      issuer: 'https://myteam.cloudflareaccess.com',
      certsUrl: 'https://myteam.cloudflareaccess.com/cdn-cgi/access/certs',
    });
    expect(config.port).toBe(3000);
  });

  it('refuses AUTH_DISABLED=true in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', AUTH_DISABLED: 'true', ...access })).toThrow(
      /AUTH_DISABLED=true is not allowed when NODE_ENV=production/,
    );
  });

  it('allows AUTH_DISABLED=true in development without Access settings', () => {
    expect(loadConfig({ NODE_ENV: 'development', AUTH_DISABLED: 'true' }).auth).toEqual({
      disabled: true,
    });
  });

  it('lists every missing Access setting at once', () => {
    let error: unknown;
    try {
      loadConfig({ NODE_ENV: 'production' });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toMatch(/CF_ACCESS_TEAM is required/);
    expect((error as Error).message).toMatch(/CF_ACCESS_AUD is required/);
  });

  it('treats empty strings from compose as unset', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        AUTH_DISABLED: '',
        CF_ACCESS_TEAM: '',
        CF_ACCESS_AUD: ' ',
      }),
    ).toThrow(/CF_ACCESS_TEAM is required/);
  });

  it('rejects a misspelt AUTH_DISABLED rather than guessing', () => {
    expect(() => loadConfig({ AUTH_DISABLED: 'yes', ...access })).toThrow(ConfigError);
  });

  it('resolves a relative PUBLIC_DIR to an absolute path', () => {
    const { publicDir } = loadConfig({ PUBLIC_DIR: '../web/dist', ...access });
    expect(publicDir && isAbsolute(publicDir)).toBe(true);
  });

  it('reads ADMIN_EMAILS lowercased, and needs at least one in production', () => {
    const { users } = loadConfig({
      ...access,
      ADMIN_EMAILS: ' Owner@Example.com, second@example.com ',
    });
    expect(users).toEqual({
      adminEmails: ['owner@example.com', 'second@example.com'],
      devUserEmail: 'dev@localhost',
    });
    expect(() => loadConfig({ NODE_ENV: 'production', ...access, ADMIN_EMAILS: '' })).toThrow(
      /ADMIN_EMAILS is required/,
    );
    expect(() => loadConfig({ ...access, ADMIN_EMAILS: 'owner' })).toThrow(/not an email address/);
    expect(
      loadConfig({ NODE_ENV: 'development', AUTH_DISABLED: 'true' }).users?.adminEmails,
    ).toEqual([]);
  });

  it('needs the VAPID keys in production, and checks them', () => {
    expect(loadConfig({ NODE_ENV: 'production', ...access }).push).toEqual({
      publicKey: access.VAPID_PUBLIC_KEY,
      privateKey: access.VAPID_PRIVATE_KEY,
      subject: 'mailto:owner@example.com',
    });
    expect(() => loadConfig({ NODE_ENV: 'production', ...access, VAPID_PRIVATE_KEY: '' })).toThrow(
      /VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT are required/,
    );
    expect(() => loadConfig({ ...access, VAPID_SUBJECT: 'owner@example.com' })).toThrow(
      /VAPID_SUBJECT must be mailto:/,
    );
    expect(() => loadConfig({ ...access, VAPID_PUBLIC_KEY: 'short' })).toThrow(
      /not a VAPID public key/,
    );
    // Development without keys: push is simply off.
    expect(loadConfig({ NODE_ENV: 'development', AUTH_DISABLED: 'true' }).push).toBeNull();
  });

  it('never binds port 8000 (the FastAPI project)', () => {
    expect(() => loadConfig({ PORT: '8000', ...access })).toThrow(
      /reserved for the existing FastAPI/,
    );
  });
});

describe('normaliseAccessTeam', () => {
  it.each([
    'myteam',
    'MyTeam',
    'myteam.cloudflareaccess.com',
    'https://myteam.cloudflareaccess.com',
    'https://myteam.cloudflareaccess.com/cdn-cgi/access/certs',
  ])('%s → myteam', (input) => {
    expect(normaliseAccessTeam(input)).toBe('myteam');
  });
});
