import type { Model } from 'mongoose';
import { UserModel as CoreUserModel } from '../modules/users/user.model.js';

/**
 * The customer account is owned by the auth/users module (ObjectId _id, canonical KYC
 * vocabulary 
one|pending|verified|rejected). Marketplace modules only read the fields below
 * and never write to the user document.
 */
export interface IAddress {
  id: string;
  kind: 'pickup' | 'delivery';
  label: string;
  streetAddress: string;
  city: string;
  region: string;
  country: string;
  contactPerson?: string;
  contactPhone?: string;
  isDefault: boolean;
  importPermitNumber?: string;
}

export interface IUser {
  _id: { toString(): string };
  phone?: string;
  email?: string;
  roles: string[];
  kycStatus: string;
  tier: 1 | 2 | 3;
  profile?: { fullName?: string; displayName?: string; companyName?: string; countryCode?: string; avatarUrl?: string };
  addresses: IAddress[];
  createdAt: Date;
}

export const UserModel = CoreUserModel as unknown as Model<IUser>;
