import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import { createHash } from 'crypto';

const ALLOWED_REASONS = [
  'Interventional Cardiology',
  'General Cardiology',
  'Endocrinology',
  'Diabetes Management',
  'Obesity Medicine / GLP-1 Treatment',
  'Combined Cardiometabolic Consultation',
  'Unsure — Please Advise',
  'Diabetes',
  'Obesity / Weight Management',
  'Thyroid',
  'Cardiology',
  'Chest Pain',
  'Palpitations',
  'Hypertension',
  'Other',
];

function sanitise(val, maxLen = 500) {
  if (typeof val !== 'string') return '';
  return val.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, maxLen);
}

function isValidDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s); }
function isValidPhone(s) { return /^[+()d\s.\-]{7,30}$/.test(s); }
function isValidEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s); }

export async function onRequestPost(context) {
  const { request, env } = context;
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY, NOTIFY_TO, NOTIFY_FROM } = env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !RESEND_API_KEY || !NOTIFY_TO || !NOTIFY_FROM) {
    console.error('Missing environment variables');
    return Response.json({ ok: false, error: 'Service temporarily unavailable. Please call us directly.' }, { status: 503 });
  }

  const rawBody = await request.text();
  if (rawBody.length > 8192) return Response.json({ ok: false, error: 'Request too large.' }, { status: 413 });

  let body;
  try { body = JSON.parse(rawBody); } catch { return Response.json({ ok: false, error: 'Invalid request.' }, { status: 400 }); }

  if (body.website) return Response.json({ ok: true }, { status: 200 });

  const fullName       = sanitise(body.full_name, 200);
  const dateOfBirth    = sanitise(body.date_of_birth, 12);
  const phone          = sanitise(body.phone, 30);
  const email          = sanitise(body.email, 200);
  const reason         = sanitise(body.reason, 100);
  const gpNamePractice = sanitise(body.gp_name_and_practice, 300);
  const gdprConsent    = body.gdpr_consent === true;
  const startedAt      = Number(body.startedAt) || 0;
  const insurance      = sanitise(body.insurance, 100);
  const urgency        = sanitise(body.urgency, 50);
  const preferred      = sanitise(body.preferred, 50);
  const notes          = sanitise(body.notes, 500);

  const errors = [];
  if (fullName.length < 2)               errors.push('Full name is required.');
  if (!isValidDate(dateOfBirth))         errors.push('Date of birth must be in YYYY-MM-DD format.');
  if (!isValidPhone(phone))              errors.push('A valid phone number is required.');
  if (!isValidEmail(email))              errors.push('A valid email address is required.');
  if (!ALLOWED_REASONS.includes(reason)) errors.push('Please select a valid reason for appointment.');
  if (!gdprConsent)                      errors.push('GDPR consent is required.');
  if (errors.length > 0) return Response.json({ ok: false, error: errors[0] }, { status: 422 });

  const elapsed = Date.now() - startedAt;
  if (startedAt > 0 && elapsed < 3000) return Response.json({ ok: false, error: 'Submission too fast. Please try again.' }, { status: 429 });

  const rawIp = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '';
  const ipHash = rawIp ? createHash('sha256').update(rawIp).digest('hex') : null;
  const userAgentHint = (request.headers.get('user-agent') || '').slice(0, 200);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { error: dbError } = await supabase.from('appointments').insert({
    full_name:         fullName,
    date_of_birth:     dateOfBirth,
    phone:             phone,
    email:             email,
    reason:            reason,
    gp_name_practice:  gpNamePractice || null,
    gdpr_consent:      true,
    ip_hash:           ipHash,
    user_agent_hint:   userAgentHint,
  });

  if (dbError) {
    console.error('Supabase insert error:', dbError);
    return Response.json({ ok: false, error: 'We could not save your request. Please call us directly on 089 656 7597.' }, { status: 500 });
  }

  try {
    const resend = new Resend(RESEND_API_KEY);
    await resend.emails.send({
      from:    NOTIFY_FROM,
      to:      NOTIFY_TO,
      subject: 'New appointment request - ' + fullName + ' (' + reason + ')',
      text: [
        'NEW APPOINTMENT REQUEST - Naas Cardiology & Endocrinology Clinic',
        '=================================================================',
        '',
        'PATIENT DETAILS',
        'Name:        ' + fullName,
        'DOB:         ' + dateOfBirth,
        'Phone:       ' + phone,
        'Email:       ' + email,
        'GP/Practice: ' + (gpNamePractice || '(not provided)'),
        'Insurance:   ' + (insurance || '(not provided)'),
        '',
        'APPOINTMENT DETAILS',
        'Specialty:   ' + reason,
        'Urgency:     ' + (urgency || '(not specified)'),
        'Preferred:   ' + (preferred || '(not specified)'),
        '',
        'ADDITIONAL NOTES',
        notes || '(none)',
        '',
        'Submitted:   ' + new Date().toLocaleString('en-IE'),
        '',
        'View all appointments in Supabase -> Table Editor -> appointments',
      ].join('\n'),
    });
  } catch (emailErr) {
    console.error('Resend email error:', emailErr);
  }

  return Response.json({ ok: true }, { status: 200 });
}
