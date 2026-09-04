/**
 * src/services/auth.ts
 *
 * Merchant identity for the multi-tenant platform. Two separate credential
 * types, deliberately not interchangeable:
 *
 *  - Dashboard session (JWT): a merchant signs up/logs in with email +
 *    password from the A-COS web app. `POST /auth/signup`, `POST /auth/login`.
 *    Bcrypt-hashed passwords (cost from BCRYPT_SALT_ROUNDS), a short-lived
 *    signed JWT carries `merchant_id` and is required (Bearer token) on
 *    every dashboard-facing route.
 *
 *  - Agent API key: the credential an AI buyer agent presents on every
 *    `/agent/v1/*` call (`x-api-key` header). High-entropy random token,
 *    shown to the merchant exactly once at issuance/rotation. Only its
 *    SHA-256 hash is ever stored — losing the raw key means rotating, not
 *    recovering, exactly like every real payments API.
 *
 * New merchants are seeded with the same demo catalog/policy defaults the
 * single-tenant prototype hardcoded, so a fresh signup isn't an empty
 * store — see seedNewMerchant() at the bottom.
 */

import { randomBytes, createHash } from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import {
  insertMerchant,
  findMerchantByEmail,
  findMerchantById,
  findMerchantByApiKeyHash,
  updateMerchantApiKey,
  MerchantRow,
} from "../db/merchants";
import { seedMerchantCatalog } from "./catalog";
import { seedMerchantPolicy } from "./policy_store";

const JWT_SECRET = () => process.env.JWT_SECRET ?? "dev-only-insecure-secret";
const JWT_EXPIRES_IN_SEC = () => Number(process.env.JWT_EXPIRES_IN_SEC ?? 604800);
const SALT_ROUNDS = () => Number(process.env.BCRYPT_SALT_ROUNDS ?? 12);

export interface PublicMerchant {
  merchant_id: string;
  name: string;
  email: string;
  plan: string;
  api_key_prefix: string;
  created_at: string;
}

function toPublic(m: MerchantRow): PublicMerchant {
  return {
    merchant_id: m.id,
    name: m.name,
    email: m.email,
    plan: m.plan,
    api_key_prefix: m.apiKeyPrefix,
    created_at: m.createdAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* API keys                                                             */
/* ------------------------------------------------------------------ */

function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const raw = `acos_live_${randomBytes(24).toString("hex")}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash, prefix: raw.slice(0, 14) };
}

/* ------------------------------------------------------------------ */
/* JWT session tokens                                                   */
/* ------------------------------------------------------------------ */

export function signSessionToken(merchantId: string): string {
  return jwt.sign({ merchant_id: merchantId }, JWT_SECRET(), { expiresIn: JWT_EXPIRES_IN_SEC() });
}

export function verifySessionToken(token: string): { merchant_id: string } | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET());
    if (typeof decoded === "object" && decoded && typeof (decoded as any).merchant_id === "string") {
      return { merchant_id: (decoded as any).merchant_id };
    }
    return null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Signup / login                                                       */
/* ------------------------------------------------------------------ */

export type AuthResult =
  | { ok: true; merchant: PublicMerchant; token: string; api_key?: string }
  | { ok: false; httpStatus: number; error: string };

function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function signup(name: string, email: string, password: string): Promise<AuthResult> {
  if (!name?.trim()) return { ok: false, httpStatus: 400, error: "name is required" };
  if (!validateEmail(email ?? "")) return { ok: false, httpStatus: 400, error: "a valid email is required" };
  if (!password || password.length < 8) {
    return { ok: false, httpStatus: 400, error: "password must be at least 8 characters" };
  }

  const existing = await findMerchantByEmail(email);
  if (existing) return { ok: false, httpStatus: 409, error: "An account with this email already exists" };

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS());
  const { raw: apiKey, hash: apiKeyHash, prefix: apiKeyPrefix } = generateApiKey();

  const merchant = await insertMerchant({ name: name.trim(), email, passwordHash, apiKeyHash, apiKeyPrefix });

  // A brand-new tenant gets the same demo catalog/policy the single-tenant
  // prototype shipped with, so the dashboard isn't an empty shell on first
  // login — mirrors how most commerce platforms seed a fresh account.
  await seedMerchantCatalog(merchant.id);
  await seedMerchantPolicy(merchant.id);

  const token = signSessionToken(merchant.id);
  return { ok: true, merchant: toPublic(merchant), token, api_key: apiKey };
}

export async function login(email: string, password: string): Promise<AuthResult> {
  if (!email || !password) return { ok: false, httpStatus: 400, error: "email and password are required" };

  const merchant = await findMerchantByEmail(email);
  if (!merchant) return { ok: false, httpStatus: 401, error: "Invalid email or password" };

  const valid = await bcrypt.compare(password, merchant.passwordHash);
  if (!valid) return { ok: false, httpStatus: 401, error: "Invalid email or password" };

  const token = signSessionToken(merchant.id);
  return { ok: true, merchant: toPublic(merchant), token };
}

export async function getMerchant(merchantId: string): Promise<PublicMerchant | undefined> {
  const m = await findMerchantById(merchantId);
  return m ? toPublic(m) : undefined;
}

/** Rotates the merchant's agent API key. The old key stops working immediately. Returns the new raw key ONCE. */
export async function rotateApiKey(merchantId: string): Promise<{ api_key: string; api_key_prefix: string } | undefined> {
  const merchant = await findMerchantById(merchantId);
  if (!merchant) return undefined;
  const { raw, hash, prefix } = generateApiKey();
  await updateMerchantApiKey(merchantId, hash, prefix);
  return { api_key: raw, api_key_prefix: prefix };
}

/** Resolves a raw `x-api-key` header value to its owning merchant, or undefined if invalid. */
export async function resolveMerchantByApiKey(rawKey: string | undefined): Promise<PublicMerchant | undefined> {
  if (!rawKey) return undefined;
  const hash = createHash("sha256").update(rawKey).digest("hex");
  const merchant = await findMerchantByApiKeyHash(hash);
  return merchant ? toPublic(merchant) : undefined;
}
