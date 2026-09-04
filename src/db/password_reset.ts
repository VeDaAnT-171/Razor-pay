/**
 * src/db/password_reset.ts — repository layer for password-reset tokens.
 */

import { randomUUID } from "crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "./client";
import { passwordResetTokens } from "./schema";

export interface PasswordResetTokenRow {
  id: string;
  merchantId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export async function insertResetToken(input: {
  merchantId: string;
  tokenHash: string;
  expiresAt: Date;
}): Promise<PasswordResetTokenRow> {
  const id = `prt_${randomUUID()}`;
  const [row] = await db
    .insert(passwordResetTokens)
    .values({ id, merchantId: input.merchantId, tokenHash: input.tokenHash, expiresAt: input.expiresAt })
    .returning();
  return row as PasswordResetTokenRow;
}

/** A token is valid iff unused and not yet expired. */
export async function findValidResetToken(tokenHash: string): Promise<PasswordResetTokenRow | undefined> {
  const rows = await db
    .select()
    .from(passwordResetTokens)
    .where(and(eq(passwordResetTokens.tokenHash, tokenHash), isNull(passwordResetTokens.usedAt), gt(passwordResetTokens.expiresAt, new Date())))
    .limit(1);
  return rows[0] as PasswordResetTokenRow | undefined;
}

export async function markResetTokenUsed(id: string): Promise<void> {
  await db.update(passwordResetTokens).set({ usedAt: new Date() }).where(eq(passwordResetTokens.id, id));
}
