import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initializeDatabase } from '../src/bootstrap/initialize-database.js';
import { DEV_ADMIN_EMAIL, DEV_ADMIN_PASSWORD } from '../src/bootstrap/seed-policy.js';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { resetEnvCache } from '../src/config/env.js';
import { Role } from '../src/modules/auth/auth.models.js';
import { MineralCategory } from '../src/modules/reference/reference.model.js';
import { ProductModel } from '../src/models/catalog.model.js';
import { createStaff, verifyCredentials } from '../src/modules/staff/staff.service.js';
import { StaffModel } from '../src/modules/staff/staff.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { startMemoryReplSet, stopMemoryReplSet } from './setup.js';

let uri = '';

async function hashOf(email: string): Promise<string> {
  const row = await StaffModel.findOne({ email }).select('+passwordHash').lean<{ passwordHash?: string }>();
  return row?.passwordHash ?? '';
}

describe('automatic database initialization', () => {
  beforeAll(async () => {
    uri = await startMemoryReplSet('mb_auto_seed');
    process.env.MONGODB_URI = uri;
    resetEnvCache();
    await connectDatabase(uri);
  }, 120_000);

  afterAll(async () => {
    await disconnectDatabase();
    await stopMemoryReplSet();
  });

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    delete process.env.SEED_ADMIN_EMAIL;
    delete process.env.SEED_ADMIN_PASSWORD;
    delete process.env.SEED_ADMIN_PHONE;
    delete process.env.SEED_ADMIN_NAME;
    delete process.env.SEED_USER_EMAIL;
    delete process.env.SEED_USER_PASSWORD;
    delete process.env.SEED_USER_NAME;
    delete process.env.SEED_SAMPLE_DATA;
    delete process.env.AUTO_SEED;
    delete process.env.SEED_ONLY;
  });

  it('initializes a fresh local database, then leaves it unchanged on restart', async () => {
    const first = await initializeDatabase({ trigger: 'startup', nodeEnv: 'development', mongoUri: uri });
    expect(first.skipped).toBe(false);
    if (first.skipped) return;
    expect(first.admin).toBe('created');
    expect(first.sampleData).toBe(true);
    expect(first.roles.inserted).toBe(6);
    expect(first.catalogue.inserted).toBeGreaterThan(12);
    expect(await ProductModel.countDocuments()).toBe(12);
    expect(first.reference.inserted).toBeGreaterThan(0);
    expect(await verifyCredentials(DEV_ADMIN_EMAIL, DEV_ADMIN_PASSWORD)).toMatchObject({ role: { id: 'ROLE-CEO' } });
    const ceo = await StaffModel.findOne({ email: DEV_ADMIN_EMAIL }).lean<{ roleKey?: string }>();
    expect(ceo?.roleKey).toBe('super');
    const role = await Role.findOne({ roleId: 'ROLE-CEO' }).lean<{ key?: string; access?: { settings?: string } }>();
    expect(role?.key).toBe('super');
    expect(role?.access?.settings).toBe('edit');

    await MineralCategory.updateOne({ categoryId: 'CAT-PRECIOUS' }, { $set: { name: 'Edited metals' } });
    const passwordHash = await hashOf(DEV_ADMIN_EMAIL);
    process.env.SEED_ADMIN_PASSWORD = 'Different-Password-99';

    const second = await initializeDatabase({ trigger: 'startup', nodeEnv: 'development', mongoUri: uri });
    expect(second.skipped).toBe(false);
    if (second.skipped) return;
    expect(second.admin).toBe('unchanged');
    expect(second.roles.inserted).toBe(0);
    expect(second.catalogue.inserted).toBe(0);
    expect(second.reference.inserted).toBe(0);
    expect((await MineralCategory.findOne({ categoryId: 'CAT-PRECIOUS' }).lean<{ name?: string }>())?.name).toBe('Edited metals');
    expect(await hashOf(DEV_ADMIN_EMAIL)).toBe(passwordHash);
    expect(await verifyCredentials(DEV_ADMIN_EMAIL, DEV_ADMIN_PASSWORD)).toBeTruthy();
    expect(await verifyCredentials(DEV_ADMIN_EMAIL, 'Different-Password-99')).toBeNull();

    const roles = await Role.countDocuments();
    const products = await ProductModel.countDocuments();
    const third = await initializeDatabase({ trigger: 'cli', nodeEnv: 'development', mongoUri: uri });
    expect(third.skipped).toBe(false);
    expect(await Role.countDocuments()).toBe(roles);
    expect(await ProductModel.countDocuments()).toBe(products);
  });

  it('does not replace an existing staff password or add sample lots beside a real catalogue', async () => {
    await createStaff({
      email: DEV_ADMIN_EMAIL,
      password: 'Keep-This-Password-1',
      name: 'Existing CEO',
      phone: '+254700000099',
      roleId: 'ROLE-CEO',
    });
    await ProductModel.create({
      reference: 'REAL-LOT',
      name: 'Operator lot',
      typeSlug: 'gold',
      categorySlug: 'precious-metals',
      mineralCode: 'AU',
      origin: { country: 'KE' },
      status: 'active',
      availableGrams: 10,
      unitPriceMinorE4PerGram: 1,
    });
    const report = await initializeDatabase({ trigger: 'startup', nodeEnv: 'development', mongoUri: uri });
    expect(report.skipped).toBe(false);
    if (report.skipped) return;
    expect(report.admin).toBe('unchanged');
    expect(report.catalogue.skipped).toBe(true);
    expect(await ProductModel.countDocuments()).toBe(1);
    expect((await ProductModel.findOne({ reference: 'REAL-LOT' }).lean<{ name?: string }>())?.name).toBe('Operator lot');
    expect(await verifyCredentials(DEV_ADMIN_EMAIL, 'Keep-This-Password-1')).toBeTruthy();
    expect(await verifyCredentials(DEV_ADMIN_EMAIL, DEV_ADMIN_PASSWORD)).toBeNull();
  });

  it('creates a local development customer once and does not reset that password', async () => {
    process.env.SEED_USER_EMAIL = 'buyer@mineralbridge.co.ke';
    process.env.SEED_USER_PASSWORD = 'Buyer-Pass-1';
    const created = await initializeDatabase({ trigger: 'startup', nodeEnv: 'development', mongoUri: uri });
    expect(created.skipped).toBe(false);
    if (created.skipped) return;
    expect(created.user).toBe('created');
    const before = await UserModel.findOne({ email: 'buyer@mineralbridge.co.ke' }).select('+passwordHash').lean<{ passwordHash?: string; profile?: { fullName?: string } }>();
    expect(before?.profile?.fullName).toBe('Mineral Bridge User');

    process.env.SEED_USER_PASSWORD = 'Buyer-Pass-2';
    process.env.SEED_USER_NAME = 'Renamed User';
    const again = await initializeDatabase({ trigger: 'startup', nodeEnv: 'development', mongoUri: uri });
    expect(again.skipped).toBe(false);
    if (again.skipped) return;
    expect(again.user).toBe('unchanged');
    const after = await UserModel.findOne({ email: 'buyer@mineralbridge.co.ke' }).select('+passwordHash').lean<{ passwordHash?: string; profile?: { fullName?: string } }>();
    expect(after?.passwordHash).toBe(before?.passwordHash);
    expect(after?.profile?.fullName).toBe('Mineral Bridge User');
    expect(await UserModel.countDocuments({ email: 'buyer@mineralbridge.co.ke' })).toBe(1);
  });

  it('seeds structure but not sample data or test credentials when the URI is remote', async () => {
    const report = await initializeDatabase({
      trigger: 'startup',
      nodeEnv: 'development',
      mongoUri: 'mongodb+srv://user:secret@cluster.example.mongodb.net/mineral_bridge',
    });
    expect(report.skipped).toBe(false);
    if (report.skipped) return;
    expect(report.sampleData).toBe(false);
    expect(report.admin).toBe('skipped');
    expect(report.user).toBe('skipped');
    expect(report.roles.inserted).toBe(6);
    expect(await ProductModel.countDocuments()).toBe(0);
    expect(await StaffModel.countDocuments()).toBe(0);
    expect(await UserModel.countDocuments()).toBe(0);
  });

  it('refuses sample data and the development password in production, then creates a strong admin once', async () => {
    process.env.SEED_SAMPLE_DATA = 'true';
    process.env.SEED_ADMIN_EMAIL = DEV_ADMIN_EMAIL;
    process.env.SEED_ADMIN_PASSWORD = DEV_ADMIN_PASSWORD;
    process.env.SEED_ADMIN_PHONE = '+254700000001';
    process.env.SEED_USER_EMAIL = 'buyer@mineralbridge.co.ke';
    process.env.SEED_USER_PASSWORD = 'Buyer-Pass-1';
    const blocked = await initializeDatabase({ trigger: 'startup', nodeEnv: 'production', mongoUri: uri });
    expect(blocked.skipped).toBe(false);
    if (blocked.skipped) return;
    expect(blocked.sampleData).toBe(false);
    expect(blocked.admin).toBe('skipped');
    expect(blocked.user).toBe('skipped');
    expect(blocked.warnings.length).toBeGreaterThan(0);
    expect(await ProductModel.countDocuments()).toBe(0);
    expect(await StaffModel.countDocuments()).toBe(0);
    expect(await Role.countDocuments()).toBe(6);

    process.env.SEED_ADMIN_PASSWORD = 'A-Long-Unique-Passphrase-1!';
    const created = await initializeDatabase({ trigger: 'startup', nodeEnv: 'production', mongoUri: uri });
    expect(created.skipped).toBe(false);
    if (created.skipped) return;
    expect(created.admin).toBe('created');
    expect(await ProductModel.countDocuments()).toBe(0);
    const passwordHash = await hashOf(DEV_ADMIN_EMAIL);
    process.env.SEED_ADMIN_PASSWORD = 'Another-Unique-Passphrase-2!';
    const again = await initializeDatabase({ trigger: 'startup', nodeEnv: 'production', mongoUri: uri });
    expect(again.skipped).toBe(false);
    if (again.skipped) return;
    expect(again.admin).toBe('unchanged');
    expect(await hashOf(DEV_ADMIN_EMAIL)).toBe(passwordHash);
    expect(await verifyCredentials(DEV_ADMIN_EMAIL, 'A-Long-Unique-Passphrase-1!')).toBeTruthy();
  });

  it('does not write when automatic initialization is turned off', async () => {
    process.env.AUTO_SEED = 'false';
    const skipped = await initializeDatabase({ trigger: 'startup', nodeEnv: 'development', mongoUri: uri });
    expect(skipped.skipped).toBe(true);
    expect(await Role.countDocuments()).toBe(0);
    const manual = await initializeDatabase({ trigger: 'cli', nodeEnv: 'development', mongoUri: uri });
    expect(manual.skipped).toBe(false);
    expect(await Role.countDocuments()).toBe(6);
  });

  it('refuses to initialize when the database is not connected', async () => {
    await disconnectDatabase();
    await expect(initializeDatabase({ trigger: 'startup', nodeEnv: 'development', mongoUri: uri })).rejects.toThrow(/not connected/i);
    resetEnvCache();
    await connectDatabase(uri);
  });
});
