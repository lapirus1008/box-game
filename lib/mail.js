// lib/mail.js
// 메일 발송 (비밀번호 찾기 인증 코드). 지금은 Brevo(무료 하루 300통) HTTP API를 씁니다.
// 다른 서비스로 바꾸려면 이 파일의 sendMail만 고치면 됩니다.
//
// Render → Environment 에 넣을 값
//   BREVO_API_KEY : Brevo → SMTP & API → API Keys 에서 만든 키
//   MAIL_FROM     : Brevo → Senders 에서 인증한 보내는 사람 이메일 (예: 게임용 Gmail 주소)
//   MAIL_FROM_NAME: 보내는 사람 이름 (없으면 "시간의 상자")
// 로컬 시험: MAIL_DEV_LOG=1 이면 메일을 보내지 않고 서버 로그에 내용을 찍습니다.

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const SEND_TIMEOUT_MS = 10000;

function isMailConfigured() {
  return Boolean(process.env.BREVO_API_KEY && process.env.MAIL_FROM) || process.env.MAIL_DEV_LOG === '1';
}

// 로그용: 이메일 주소를 가립니다 (example@gmail.com → ex***@gmail.com)
function maskEmail(email) {
  const [name, domain] = String(email).split('@');
  return `${(name || '').slice(0, 2)}***@${domain || '?'}`;
}

// 반환: 메일 서비스가 준 메시지 ID(없으면 'dev'). 설정이 없거나 실패하면 오류를 던집니다.
async function sendMail({ to, subject, text, html }) {
  if (process.env.MAIL_DEV_LOG === '1' && !process.env.BREVO_API_KEY) {
    console.log(`[MAIL-DEV] to=${to} · ${subject}\n${text}`);
    return 'dev';
  }
  if (!process.env.BREVO_API_KEY || !process.env.MAIL_FROM) {
    throw new Error('메일 발송 설정(BREVO_API_KEY, MAIL_FROM)이 없습니다');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(BREVO_URL, {
      method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: process.env.MAIL_FROM, name: process.env.MAIL_FROM_NAME || '시간의 상자' },
        to: [{ email: to }],
        subject,
        textContent: text,
        htmlContent: html,
      }),
      signal: controller.signal,
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`메일 서비스 응답 ${res.status} ${body.slice(0, 300)}`);
    try { return JSON.parse(body).messageId || 'ok'; } catch (e) { return 'ok'; }
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendMail, isMailConfigured, maskEmail };
