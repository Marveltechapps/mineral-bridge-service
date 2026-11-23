/**
 * Decides what automatic initialization is allowed to create.
 * Sample catalogue, sample rates, the academy tour, and the development password
 * stay on a local development database. Production and any remote database do not
 * receive them.
 */

export const DEV_ADMIN_EMAIL = 'ceo@mineralbridge.co.ke';
export const DEV_ADMIN_PASSWORD = 'ChangeMe!Admin1';
export const DEV_ADMIN_PHONE = '+254700000001';
export const DEV_ADMIN_NAME = 'Platform CEO';

const WEAK_PASSWORD = /change-?me|password|admin123|letmein|qwerty/i;

export type SeedTrigger = 'startup' | 'cli';

export interface SeedPolicy {
  enabled: boolean;
  nodeEnv: string;
  localDatabase: boolean;
  sampleData: boolean;
  /** Create the CEO only when this is set. The password is never logged. */
  admin:
    | { action: 'create'; email: string; password: string; name: string; phone: string }
    | { action: 'skip' };
  /** A customer is optional. Registration remains the normal way to open an account. */
  user:
    | { action: 'create'; email: string; password: string; name: string }
    | { action: 'skip' };
  warnings: string[];
}

export function isLocalMongoUri(uri: string): boolean {
  const trimmed = uri.trim();
  if (!trimmed || trimmed.startsWith('mongodb+srv://')) return false;
  if (!trimmed.startsWith('mongodb://')) return false;
  const withoutScheme = trimmed.slice('mongodb://'.length);
  const at = withoutScheme.lastIndexOf('@');
  const hostPart = (at >= 0 ? withoutScheme.slice(at + 1) : withoutScheme).split(/[/?]/)[0] ?? '';
  if (!hostPart) return false;
  const hosts = hostPart.split(',');
  return hosts.every((entry) => {
    const host = mongoHost(entry);
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  });
}

function mongoHost(entry: string): string {
  const value = entry.trim();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return (end > 1 ? value.slice(1, end) : value).toLowerCase();
  }
  return value.replace(/:\d+$/, '').toLowerCase();
}

function flag(value: string | undefined): 'on' | 'off' | 'unset' {
  const raw = value?.trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') return 'on';
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return 'off';
  return 'unset';
}

function isWeakPassword(password: string): boolean {
  return password === DEV_ADMIN_PASSWORD || WEAK_PASSWORD.test(password);
}

export function resolveSeedPolicy(input: {
  trigger: SeedTrigger;
  nodeEnv: string;
  mongoUri: string;
  env?: NodeJS.ProcessEnv;
  staffPasswordProblem?: (password: string) => string | null;
  customerPasswordProblem?: (password: string) => string | null;
  emailDomainAllowed?: (email: string) => boolean;
}): SeedPolicy {
  const env = input.env ?? process.env;
  const warnings: string[] = [];
  const nodeEnv = input.nodeEnv;
  const localDatabase = isLocalMongoUri(input.mongoUri);
  const localDevelopment = nodeEnv === 'development' && localDatabase;
  const production = nodeEnv === 'production';

  const auto = flag(env.AUTO_SEED);
  const enabled = input.trigger === 'cli' ? true : auto === 'off' ? false : auto === 'on' ? true : nodeEnv !== 'test';

  const sampleFlag = flag(env.SEED_SAMPLE_DATA);
  let sampleData = false;
  if (production) {
    sampleData = false;
    if (sampleFlag === 'on') {
      warnings.push('SEED_SAMPLE_DATA is ignored in production. Sample catalogue, rates, and academy content were not created.');
    }
  } else if (sampleFlag === 'off') {
    sampleData = false;
  } else if (sampleFlag === 'on') {
    sampleData = true;
  } else {
    sampleData = localDevelopment;
    if (nodeEnv === 'development' && !localDatabase) {
      warnings.push('Sample catalogue, rates, and academy content are not seeded into a remote database. Set SEED_SAMPLE_DATA=true only for a disposable database.');
    }
  }

  const admin = resolveAdmin({ env, localDevelopment, production, warnings, staffPasswordProblem: input.staffPasswordProblem, emailDomainAllowed: input.emailDomainAllowed });
  const user = resolveUser({ env, localDevelopment, production, warnings, customerPasswordProblem: input.customerPasswordProblem });

  return { enabled, nodeEnv, localDatabase, sampleData, admin, user, warnings };
}

function resolveAdmin(input: {
  env: NodeJS.ProcessEnv;
  localDevelopment: boolean;
  production: boolean;
  warnings: string[];
  staffPasswordProblem?: (password: string) => string | null;
  emailDomainAllowed?: (email: string) => boolean;
}): SeedPolicy['admin'] {
  const emailExplicit = input.env.SEED_ADMIN_EMAIL?.trim().toLowerCase() ?? '';
  const passwordExplicit = input.env.SEED_ADMIN_PASSWORD ?? '';
  const phoneExplicit = input.env.SEED_ADMIN_PHONE?.trim() ?? '';
  const name = input.env.SEED_ADMIN_NAME?.trim() || DEV_ADMIN_NAME;

  const email = emailExplicit || (input.localDevelopment ? DEV_ADMIN_EMAIL : '');
  const password = passwordExplicit || (input.localDevelopment ? DEV_ADMIN_PASSWORD : '');
  const phone = phoneExplicit || (input.localDevelopment ? DEV_ADMIN_PHONE : '');
  const builtinPassword = !passwordExplicit && password === DEV_ADMIN_PASSWORD;

  if (!email && !password && !input.localDevelopment) {
    input.warnings.push(
      input.production
        ? 'No production admin was created. Set SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, and SEED_ADMIN_PHONE to create the first CEO when that email does not already exist.'
        : 'Admin credentials are not configured for this remote database. No staff account was created or changed.',
    );
    return { action: 'skip' };
  }
  if (!email || !password || !phone) {
    input.warnings.push('SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, and SEED_ADMIN_PHONE must all be set before an admin is created. Nothing was changed.');
    return { action: 'skip' };
  }
  if (!input.localDevelopment && (builtinPassword || isWeakPassword(password))) {
    input.warnings.push('Refusing to seed the development admin password outside a local development database.');
    return { action: 'skip' };
  }
  const problem = input.staffPasswordProblem?.(password);
  if (problem) {
    input.warnings.push(`Admin password was not applied (${problem}). The existing staff row, if any, was left unchanged.`);
    return { action: 'skip' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    input.warnings.push('SEED_ADMIN_EMAIL is not a valid email. No admin was created.');
    return { action: 'skip' };
  }
  if (input.emailDomainAllowed && !input.emailDomainAllowed(email)) {
    input.warnings.push('SEED_ADMIN_EMAIL is outside the staff email domains, so the account could not sign in. No admin was created.');
    return { action: 'skip' };
  }
  return { action: 'create', email, password, name, phone };
}

function resolveUser(input: {
  env: NodeJS.ProcessEnv;
  localDevelopment: boolean;
  production: boolean;
  warnings: string[];
  customerPasswordProblem?: (password: string) => string | null;
}): SeedPolicy['user'] {
  const email = input.env.SEED_USER_EMAIL?.trim().toLowerCase() ?? '';
  const password = input.env.SEED_USER_PASSWORD ?? '';
  const name = input.env.SEED_USER_NAME?.trim() || 'Mineral Bridge User';
  if (!email && !password) return { action: 'skip' };
  if (input.production || !input.localDevelopment) {
    input.warnings.push('SEED_USER_EMAIL is ignored outside a local development database. Customer accounts are created by registration.');
    return { action: 'skip' };
  }
  if (!email || !password) {
    input.warnings.push('SEED_USER_EMAIL and SEED_USER_PASSWORD must both be set. No customer was created.');
    return { action: 'skip' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    input.warnings.push('SEED_USER_EMAIL is not a valid email. No customer was created.');
    return { action: 'skip' };
  }
  const problem = input.customerPasswordProblem?.(password);
  if (problem) {
    input.warnings.push(`Customer password was not applied (${problem}). No customer was created or changed.`);
    return { action: 'skip' };
  }
  return { action: 'create', email, password, name };
}
