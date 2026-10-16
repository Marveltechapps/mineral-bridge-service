import jwt from 'jsonwebtoken';
import { loadEnv } from '../../config/env.js';

export const ACCESS_TOKEN_ISSUER = 'mineralbridge';
/** Customer access tokens only — an admin session can never be presented as one, and vice versa. */
export const ACCESS_TOKEN_AUDIENCE = 'mineralbridge:customer';

export interface AccessTokenClaims {
  /** User id (ObjectId string). */
  sub: string;
  /** Public session id (`ses_…`); revoking the session invalidates the token before it expires. */
  sid: string;
  /** Client the token was minted for. A stolen mobile token cannot be replayed as web (ARCHITECTURE §3.1). */
  cli: 'mobile' | 'web';
  roles: string[];
}

export interface SignedAccessToken {
  token: string;
  /** Seconds, e.g. 900. */
  expiresIn: number;
}

export type AccessTokenVerification =
  | { ok: true; claims: AccessTokenClaims }
  | { ok: false; reason: 'expired' | 'invalid' };

interface TokenConfig {
  secret: string;
  ttlSeconds: number;
}

function config(override?: Partial<TokenConfig>): TokenConfig {
  const env = loadEnv();
  return {
    secret: override?.secret ?? env.JWT_ACCESS_SECRET,
    ttlSeconds: override?.ttlSeconds ?? env.ACCESS_TOKEN_TTL_SECONDS,
  };
}

export function signAccessToken(
  claims: AccessTokenClaims,
  override?: Partial<TokenConfig>,
): SignedAccessToken {
  const { secret, ttlSeconds } = config(override);
  const token = jwt.sign({ sid: claims.sid, cli: claims.cli, roles: claims.roles }, secret, {
    algorithm: 'HS256',
    subject: claims.sub,
    issuer: ACCESS_TOKEN_ISSUER,
    audience: ACCESS_TOKEN_AUDIENCE,
    expiresIn: ttlSeconds,
  });
  return { token, expiresIn: ttlSeconds };
}

export function verifyAccessToken(
  token: string,
  override?: Pick<Partial<TokenConfig>, 'secret'>,
): AccessTokenVerification {
  try {
    const decoded = jwt.verify(token, config(override).secret, {
      algorithms: ['HS256'],
      issuer: ACCESS_TOKEN_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
    });
    if (typeof decoded === 'string') return { ok: false, reason: 'invalid' };
    const { sub, sid, cli, roles } = decoded as jwt.JwtPayload & Partial<AccessTokenClaims>;
    if (!sub || !sid || (cli !== 'mobile' && cli !== 'web') || !Array.isArray(roles)) {
      return { ok: false, reason: 'invalid' };
    }
    return { ok: true, claims: { sub, sid, cli, roles } };
  } catch (err) {
    return { ok: false, reason: err instanceof jwt.TokenExpiredError ? 'expired' : 'invalid' };
  }
}
