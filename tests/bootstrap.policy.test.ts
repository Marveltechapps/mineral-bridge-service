import { describe, expect, it } from 'vitest';
import { DEV_ADMIN_EMAIL, DEV_ADMIN_PASSWORD, DEV_ADMIN_PHONE, isLocalMongoUri, resolveSeedPolicy } from '../src/bootstrap/seed-policy.js';

const localUri = 'mongodb://127.0.0.1:27017/mineralbridge?replicaSet=rs0&directConnection=true';
const remoteUri = 'mongodb+srv://user:secret@cluster.example.mongodb.net/mineral_bridge';

function policy(over: Partial<Parameters<typeof resolveSeedPolicy>[0]> & { env?: NodeJS.ProcessEnv } = {}) {
  return resolveSeedPolicy({
    trigger: 'startup',
    nodeEnv: 'development',
    mongoUri: localUri,
    staffPasswordProblem: (password) => (password.length < 12 ? 'too short' : null),
    customerPasswordProblem: (password) => (password.length < 10 ? 'too short' : null),
    emailDomainAllowed: (email) => email.endsWith('@mineralbridge.co.ke'),
    ...over,
  });
}

describe('seed policy', () => {
  it('treats loopback MongoDB as local and SRV as remote', () => {
    expect(isLocalMongoUri(localUri)).toBe(true);
    expect(isLocalMongoUri('mongodb://localhost:27017/mineralbridge')).toBe(true);
    expect(isLocalMongoUri(remoteUri)).toBe(false);
    expect(isLocalMongoUri('mongodb://10.0.0.8:27017/mineralbridge')).toBe(false);
  });

  it('seeds sample data and the development admin only on a local development database', () => {
    const local = policy();
    expect(local.sampleData).toBe(true);
    expect(local.admin).toMatchObject({ action: 'create', email: DEV_ADMIN_EMAIL, password: DEV_ADMIN_PASSWORD, phone: DEV_ADMIN_PHONE });
    expect(local.user.action).toBe('skip');

    const remote = policy({ mongoUri: remoteUri });
    expect(remote.sampleData).toBe(false);
    expect(remote.admin.action).toBe('skip');
    expect(remote.warnings.some((warning) => warning.includes('remote database'))).toBe(true);
  });

  it('never seeds sample data, the development password, or a customer in production', () => {
    const result = policy({
      nodeEnv: 'production',
      mongoUri: localUri,
      env: {
        SEED_SAMPLE_DATA: 'true',
        SEED_ADMIN_EMAIL: DEV_ADMIN_EMAIL,
        SEED_ADMIN_PASSWORD: DEV_ADMIN_PASSWORD,
        SEED_ADMIN_PHONE: DEV_ADMIN_PHONE,
        SEED_USER_EMAIL: 'buyer@mineralbridge.co.ke',
        SEED_USER_PASSWORD: 'Buyer-Pass-1',
      },
    });
    expect(result.sampleData).toBe(false);
    expect(result.admin.action).toBe('skip');
    expect(result.user.action).toBe('skip');
    expect(result.warnings.join(' ')).toMatch(/production/i);
  });

  it('creates a production admin only from an explicit strong password', () => {
    const result = policy({
      nodeEnv: 'production',
      env: {
        SEED_ADMIN_EMAIL: 'ceo@mineralbridge.co.ke',
        SEED_ADMIN_PASSWORD: 'A-Long-Unique-Passphrase-1!',
        SEED_ADMIN_PHONE: '+254711111111',
      },
    });
    expect(result.admin).toMatchObject({ action: 'create', email: 'ceo@mineralbridge.co.ke', phone: '+254711111111' });
    expect(result.sampleData).toBe(false);
  });

  it('refuses a customer seed and the development password on a remote development database', () => {
    const result = policy({
      mongoUri: remoteUri,
      env: {
        SEED_ADMIN_EMAIL: DEV_ADMIN_EMAIL,
        SEED_ADMIN_PASSWORD: DEV_ADMIN_PASSWORD,
        SEED_ADMIN_PHONE: DEV_ADMIN_PHONE,
        SEED_USER_EMAIL: 'buyer@mineralbridge.co.ke',
        SEED_USER_PASSWORD: 'Buyer-Pass-1',
      },
    });
    expect(result.admin.action).toBe('skip');
    expect(result.user.action).toBe('skip');
  });

  it('keeps startup initialization off in test unless AUTO_SEED is on, and the CLI always runs', () => {
    expect(policy({ nodeEnv: 'test' }).enabled).toBe(false);
    expect(policy({ nodeEnv: 'test', env: { AUTO_SEED: 'true' } }).enabled).toBe(true);
    expect(policy({ nodeEnv: 'production', trigger: 'cli', env: { AUTO_SEED: 'false' } }).enabled).toBe(true);
    expect(policy({ env: { AUTO_SEED: 'false' } }).enabled).toBe(false);
  });
});
