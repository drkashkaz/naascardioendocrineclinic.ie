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
  // Legacy / contact.html values
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

function isValidDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isValidPhone(s) {
  return /^[+()\d\s.\-]{7,30}$/.test(s);
}

function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

export const handler = async (event) => {
  // 1. Guard: POST only
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: 'Method not allowed' }) };
  }

  // 2. Guard: env vars
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY, NOTIFY_TO, NOTIFY_FROM } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !RESEND_API_KEY || !NOTIFY_TO || !NOTIFY_FROM) {
    console.error('Missing environment variables');
    return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Service temporarily unavailable. Please call us directly.' }) };
  }

  // 3. Guard: body size <= 8KB
  const rawBody = event.body || '';
  if (rawBody.length > 8192) {
    return { statusCode: 413, body: JSON.stringify({ ok: false, error: 'Request too large.' }) };
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid request.' }) };
  }

  // 4. Honeypot: if 'website' field filled => silent success
  if (body.website) {
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  // 5. Sanitise inputs
  const fullName        = sanitise(body.full_name, 200);
  const dateOfBirth     = sanitise(body.date_of_birth, 12);
  const phone           = sanitise(body.phone, 30);
  const email           = sanitise(body.email, 200);
  const reason          = sanitise(body.reason, 100);
  const gpNamePractice  = sanitise(body.gp_name_and_practice, 300);
  const gdprConsent     = body.gdpr_consent === true;
  const startedAt       = Number(body.startedAt) || 0;
  // Extra fields from index.html form
  const insurance       = sanitise(body.insurance, 100);
  const urgency         = sanitise(body.urgency, 50);
  const preferred       = sanitise(body.preferred, 50);
  const notes           = sanitise(body.notes, 500);

  // 6. Server-side validation
  const errors = [];
  if (fullName.length < 2)              errors.push('Full name is required.');
  if (!isValidDate(dateOfBirth))        errors.push('Date of birth must be in YYYY-MM-DD format.');
  if (!isValidPhone(phone))             errors.push('A valid phone number is required.');
  if (!isValidEmail(email))             errors.push('A valid email address is required.');
  if (!ALLOWED_REASONS.includes(reason)) errors.push('Please select a valid reason for appointment.');
  if (!gdprConsent)                     errors.push('GDPR consent is required.');

  if (errors.length > 0) {
    return { statusCode: 422, body: JSON.stringify({ ok: false, error: errors[0] }) };
  }

  // 7. Timing guard: < 3 seconds since page load
  const elapsed = Date.now() - startedAt;
  if (startedAt > 0 && elapsed < 3000) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'Submission too fast. Please try again.' }) };
  }

  // 8. IP hash for spam tracking (never store raw IP)
  const rawIp = event.headers['x-forwarded-for']?.split(',')[0]?.trim() || '';
  const ipHash = rawIp ? createHash('sha256').update(rawIp).digest('hex') : null;
  const userAgentHint = (event.headers['user-agent'] || '').slice(0, 200);

  // 9. Supabase insert
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { error: dbError } = await supabase.from('appointments').insert({
    full_name:        fullName,
    date_of_birth:    dateOfBirth,
    phone:            phone,
    email:            email,
    reason:           reason,
    gp_name_practice: gpNamePractice || null,
    gdpr_consent:     true,
    ip_hash:          ipHash,
    user_agent_hint:  userAgentHint,
  });

  if (dbError) {
    console.error('Supabase insert error:', dbError);
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: 'We could not save your request. Please call us directly on 089 656 7597.' }),
    };
  }

  // 10. Resend email notification (non-fatal)
  try {
    const resend = new Resend(RESEND_API_KEY);
    await resend.emails.send({
      from:    NOTIFY_FROM,
      to:      NOTIFY_TO,
      subject: `New appointment request - ${fullName} (${reason})`,
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
        'APPOINTMENTDETAILS',
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
    // Email failure is non-fatal -- booking is already saved
    console.error('Resend email error:', emailErr);
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true }),
  };
};
