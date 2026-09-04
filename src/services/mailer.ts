/**
 * src/services/mailer.ts
 *
 * Outbound transactional email — currently just password-reset links.
 * Same honesty policy as the rest of this codebase (see store_profile.ts's
 * AI Transactability Score, or Razorpay-key-optional behavior): if SMTP
 * isn't configured, nothing pretends an email was sent. The link is logged
 * server-side (visible in Render/docker logs) so the flow still WORKS in
 * Test Mode without forcing a merchant to sign up for a third email
 * provider just to try the product — but delivery is real once SMTP_HOST /
 * SMTP_USER / SMTP_PASS are set, via any standard SMTP provider (Gmail app
 * password, SendGrid, Postmark, etc.).
 */

import nodemailer, { Transporter } from "nodemailer";

function smtpConfigured(): boolean {
  return !!process.env.SMTP_HOST && !!process.env.SMTP_USER && !!process.env.SMTP_PASS;
}

let cachedTransporter: Transporter | null = null;
function getTransporter(): Transporter | null {
  if (!smtpConfigured()) return null;
  if (!cachedTransporter) {
    const port = Number(process.env.SMTP_PORT ?? 587);
    cachedTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return cachedTransporter;
}

export interface SendMailResult {
  sent: boolean;
  reason?: string;
}

export async function sendMail(to: string, subject: string, text: string): Promise<SendMailResult> {
  const transporter = getTransporter();
  if (!transporter) {
    // eslint-disable-next-line no-console
    console.log(`[mailer] SMTP not configured — email NOT actually sent.\nTo: ${to}\nSubject: ${subject}\n${text}`);
    return { sent: false, reason: "SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS unset)" };
  }
  try {
    await transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
    return { sent: true };
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error("[mailer] send failed:", err?.message ?? err);
    return { sent: false, reason: err?.message ?? String(err) };
  }
}
