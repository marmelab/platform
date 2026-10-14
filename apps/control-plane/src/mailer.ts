// The platform's own emails (M6), through the platform SMTP (settings.ts): abandoned-app notices to owners (A6), the
// welcome email of accounts created in the admin console, and membership emails (B7, members.ts). App emails (sign-up confirmation, password reset,
// invitations) are sent by each app's GoTrue with the same SMTP (app-auth.ts), not from here.
import nodemailer from "nodemailer";
import { getSettings, type SmtpSettings } from "./settings.ts";

export interface PlatformMail {
  to: string[];
  subject: string;
  text: string;
}

function transport(smtp: SmtpSettings) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    // 465: implicit TLS; otherwise STARTTLS when the server offers it (as GoTrue's mailer)
    secure: smtp.port === 465,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

/** Sends one email; false when the platform has no SMTP (nothing is sent). Throws when the relay refuses it. */
export async function sendPlatformMail(mail: PlatformMail, smtp?: SmtpSettings | null): Promise<boolean> {
  const config = smtp === undefined ? (await getSettings()).smtp : smtp;
  if (!config || mail.to.length === 0) return false;
  const mailer = transport(config);
  try {
    await mailer.sendMail({
      from: { name: config.senderName, address: config.senderEmail },
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
    });
  } finally {
    mailer.close();
  }
  return true;
}
