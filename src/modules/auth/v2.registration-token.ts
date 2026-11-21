import jwt from 'jsonwebtoken';
import { loadEnv } from '../../config/env.js';

const ISSUER = 'mineralbridge';
const AUDIENCE = 'mineralbridge:registration';
const TTL_SECONDS = 600;

export interface RegistrationClaims {
  dest: string;
  channel: 'whatsapp' | 'sms' | 'email';
  cli: 'mobile' | 'web';
  fullName?: string;
}

export function signRegistrationToken(claims: RegistrationClaims): { token: string; expiresIn: number } {
  const env = loadEnv();
  const token = jwt.sign(
    { dest: claims.dest, channel: claims.channel, cli: claims.cli, fullName: claims.fullName },
    env.JWT_ACCESS_SECRET,
    {
      algorithm: 'HS256',
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: TTL_SECONDS,
    },
  );
  return { token, expiresIn: TTL_SECONDS };
}

export function verifyRegistrationToken(
  token: string,
): { ok: true; claims: RegistrationClaims } | { ok: false } {
  try {
    const env = loadEnv();
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (typeof decoded === 'string') return { ok: false };
    const { dest, channel, cli, fullName } = decoded as jwt.JwtPayload & Partial<RegistrationClaims>;
    if (!dest || !channel || (cli !== 'mobile' && cli !== 'web')) return { ok: false };
    if (channel !== 'whatsapp' && channel !== 'sms' && channel !== 'email') return { ok: false };
    return { ok: true, claims: { dest, channel, cli, fullName } };
  } catch {
    return { ok: false };
  }
}
