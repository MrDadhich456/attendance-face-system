const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const helmet = require('helmet');

// Auto-load .env file if available
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...vals] = trimmed.split('=');
      if (key && !process.env[key.trim()]) {
        process.env[key.trim()] = vals.join('=').trim();
      }
    }
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';
const DATABASE_URL = process.env.DATABASE_URL;

if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD) {
  throw new Error('ADMIN_PASSWORD must be set when running in production.');
}
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL must be set to a PostgreSQL connection URL in process environment or .env file.');
}

// ---------------------------------------------------------------------------
// Production middleware — compression, security headers, proxy trust
// ---------------------------------------------------------------------------

// Trust nginx reverse proxy (for correct IP in rate limiting & logs)
app.set('trust proxy', 1);

// Gzip compression — reduces response size by ~70%
app.use(compression());

// Security headers
app.use(helmet({
  contentSecurityPolicy: false,  // allow inline scripts in our HTML
}));

// ---------------------------------------------------------------------------
// PostgreSQL connection pool — tuned for ~300 concurrent users
// ---------------------------------------------------------------------------

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 20,                   // max connections in pool
  idleTimeoutMillis: 30000,  // close idle clients after 30s
  connectionTimeoutMillis: 5000, // fail fast if pool exhausted
});

// No more base64 photos — keep a small JSON limit
app.use(express.json({ limit: '100kb' }));

// Static files with caching headers (1 hour for HTML, 7 days for assets)
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  etag: true,
}));

// ---------------------------------------------------------------------------
// Rate limiting — prevent abuse on check-in endpoint
// ---------------------------------------------------------------------------

const checkinLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 5,                // 5 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Please wait a minute before trying again.' },
});

// Global rate limit — lighter, protects all routes
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Please slow down.' },
});

app.use(globalLimiter);

// ---------------------------------------------------------------------------
// Request timeout middleware
// ---------------------------------------------------------------------------

app.use((req, res, next) => {
  req.setTimeout(30000);
  res.setTimeout(30000);
  next();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TIMEZONE = process.env.TIMEZONE || 'Asia/Kolkata';

function getLocalTimeString() {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(new Date());
  const hour = parts.find(p => p.type === 'hour').value.padStart(2, '0');
  const minute = parts.find(p => p.type === 'minute').value.padStart(2, '0');
  return `${hour}:${minute}`;
}

function todayStr() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = formatter.formatToParts(new Date());
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  return `${year}-${month}-${day}`;
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function activeSession(s) {
  if (!s) return null;
  const hhmm = getLocalTimeString();
  const pad = (t) => String(t || '').trim().padStart(5, '0');
  const mStart = pad(s.morning_start);
  const mEnd = pad(s.morning_end);
  const aStart = pad(s.afternoon_start);
  const aEnd = pad(s.afternoon_end);

  if (hhmm >= mStart && hhmm <= mEnd) return 'morning';
  if (hhmm >= aStart && hhmm <= aEnd) return 'afternoon';
  return null;
}

function sessionLabel(session) {
  return session === 'morning' ? 'Before lunch' : 'After lunch';
}

function sanitize(val) {
  return typeof val === 'string' ? val.trim().replace(/\s+/g, ' ') : '';
}

function normalizeMobile(mobile) {
  return String(mobile || '').replace(/\D/g, '');
}

function isValidMobile(mobile) {
  return /^\d{10}$/.test(normalizeMobile(mobile));
}

async function getSettings() {
  return (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];
}

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.connection?.remoteAddress ||
         req.ip ||
         'unknown';
}

// ---------------------------------------------------------------------------
// Database initialisation
// ---------------------------------------------------------------------------

async function initializeDatabase() {
  // --- Migration: drop old incompatible tables from v1 (face recognition) ---
  // The old 'students' table stored face descriptors and is no longer needed.
  // The old 'attendance' table had columns (student_id, mobile, match_confidence)
  // that don't exist in v2, and lacked roll_number/device_id/ip_address.
  // We detect the old schema by checking for columns that no longer exist.
  // Detect old schema (v1 had student_id, v2 had roll_number) and migrate
  const oldV1Check = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'attendance' AND column_name IN ('student_id', 'roll_number')
  `);
  if (oldV1Check.rows.length > 0) {
    console.log('Detected old schema — migrating to current version...');
    await pool.query('DROP TABLE IF EXISTS attendance CASCADE');
    await pool.query('DROP TABLE IF EXISTS device_limits CASCADE');
    await pool.query('DROP TABLE IF EXISTS students CASCADE');
    console.log('Old tables dropped. Recreating with new schema...');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      venue_lat DOUBLE PRECISION,
      venue_lng DOUBLE PRECISION,
      radius_m DOUBLE PRECISION DEFAULT 100,
      morning_start TEXT DEFAULT '09:00',
      morning_end TEXT DEFAULT '13:00',
      afternoon_start TEXT DEFAULT '14:00',
      afternoon_end TEXT DEFAULT '17:00',
      venue_label TEXT DEFAULT 'Induction Venue'
    );

    CREATE TABLE IF NOT EXISTS attendance (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      branch TEXT NOT NULL,
      mobile TEXT NOT NULL,
      date TEXT NOT NULL,
      session TEXT NOT NULL DEFAULT 'morning',
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      accuracy DOUBLE PRECISION,
      distance_m DOUBLE PRECISION,
      device_id TEXT NOT NULL,
      ip_address TEXT
    );

    CREATE TABLE IF NOT EXISTS device_limits (
      device_id TEXT NOT NULL,
      date TEXT NOT NULL,
      session TEXT NOT NULL,
      mobile TEXT NOT NULL,
      marked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (device_id, date, session)
    );

    CREATE INDEX IF NOT EXISTS idx_att_date ON attendance(date);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_att_mobile_date_session
      ON attendance(mobile, date, session);
    CREATE INDEX IF NOT EXISTS idx_device_limits_date ON device_limits(date);
  `);

  await pool.query(`
    INSERT INTO settings
      (id, venue_lat, venue_lng, radius_m, morning_start, morning_end,
       afternoon_start, afternoon_end, venue_label)
    VALUES (1, 26.4499, 74.6399, 100, '09:00', '13:00', '14:00', '17:00', 'Induction Venue')
    ON CONFLICT (id) DO NOTHING
  `);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Status — venue info and session window
app.get('/api/status', async (req, res, next) => {
  try {
    const venue = await getSettings();
    const session = activeSession(venue);
    res.json({
      ok: true,
      date: todayStr(),
      venue: {
        lat: venue.venue_lat,
        lng: venue.venue_lng,
        radius: venue.radius_m,
        label: venue.venue_label,
      },
      window: {
        open: !!session,
        session,
        label: session ? sessionLabel(session) : null,
        message: session ? 'Attendance is open.' : 'Attendance is currently closed.',
      },
    });
  } catch (err) {
    next(err);
  }
});

// Check-in — the single attendance endpoint
app.post('/api/checkin', checkinLimiter, async (req, res, next) => {
  try {
    let { name, branch, mobile, lat, lng, accuracy, deviceId } = req.body || {};

    // Sanitize & validate
    name = sanitize(name);
    branch = sanitize(branch);
    const mobileClean = normalizeMobile(mobile);
    const deviceIdClean = sanitize(deviceId);
    const ipAddress = getClientIP(req);

    if (!name || name.length < 2 || name.length > 100) {
      return res.status(400).json({ ok: false, error: 'Enter your full name (2–100 characters).' });
    }
    if (!branch) {
      return res.status(400).json({ ok: false, error: 'Select your branch.' });
    }
    if (!isValidMobile(mobileClean)) {
      return res.status(400).json({
        ok: false,
        error: 'Enter a valid 10-digit mobile number.',
      });
    }
    if (!deviceIdClean) {
      return res.status(400).json({ ok: false, error: 'Device identification required. Clear cache and retry.' });
    }

    // Session check
    const venue = await getSettings();
    const session = activeSession(venue);
    if (!session) {
      return res.status(403).json({
        ok: false,
        reason: 'attendance_closed',
        error: 'Attendance is currently closed. Please try again when it is open.',
      });
    }

    // Geofence check (enforced whenever location coordinates are available)
    let dist = null;
    const hasLocation = Number.isFinite(lat) && Number.isFinite(lng);
    if (hasLocation) {
      dist = distanceMeters(lat, lng, venue.venue_lat, venue.venue_lng);
      if (dist > venue.radius_m) {
        return res.status(403).json({
          ok: false,
          reason: 'outside_venue',
          error: `You are ${Math.round(dist)}m away from the venue. Must be within ${venue.radius_m}m.`,
        });
      }
    }

    const date = todayStr();

    // --- Transactional insert with SERIALIZABLE isolation ---
    // This prevents race conditions when 250+ students hit the endpoint simultaneously
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

      // Check 1: Has this device already marked attendance in this session today?
      const deviceCheck = await client.query(
        'SELECT mobile FROM device_limits WHERE device_id = $1 AND date = $2 AND session = $3',
        [deviceIdClean, date, session]
      );
      if (deviceCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          ok: false,
          reason: 'device_limit',
          error: `This device has already been used to mark ${sessionLabel(session)} attendance today. One device can only mark attendance once per session.`,
        });
      }

      // Check 2: Has this mobile number already been marked for this session?
      const mobileCheck = await client.query(
        'SELECT id FROM attendance WHERE mobile = $1 AND date = $2 AND session = $3',
        [mobileClean, date, session]
      );
      if (mobileCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          ok: false,
          reason: 'already_marked',
          error: `${sessionLabel(session)} attendance for this mobile number is already marked today.`,
        });
      }

      // Insert attendance record
      await client.query(
        `INSERT INTO attendance
           (name, branch, mobile, date, session, timestamp,
            lat, lng, accuracy, distance_m, device_id, ip_address)
         VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7,$8,$9,$10,$11)`,
        [
          name, branch, mobileClean, date, session,
          hasLocation ? lat : null,
          hasLocation ? lng : null,
          hasLocation && Number.isFinite(accuracy) ? accuracy : null,
          dist, deviceIdClean, ipAddress,
        ]
      );

      // Insert device limit record
      await client.query(
        `INSERT INTO device_limits (device_id, date, session, mobile)
         VALUES ($1, $2, $3, $4)`,
        [deviceIdClean, date, session, mobileClean]
      );

      await client.query('COMMIT');

      res.json({
        ok: true,
        message: `${sessionLabel(session)} attendance marked successfully!`,
        student: { name, branch, mobile: mobileClean },
        distance: Math.round(dist),
      });
    } catch (txErr) {
      await client.query('ROLLBACK');

      // Handle serialization failure (concurrent transaction conflict)
      // Error code 40001 = serialization_failure
      if (txErr.code === '40001') {
        return res.status(409).json({
          ok: false,
          error: 'Server is busy. Please tap the button again in a moment.',
        });
      }
      // Handle unique constraint violations (belt-and-suspenders with the checks above)
      if (txErr.code === '23505') {
        if (txErr.constraint?.includes('device')) {
          return res.status(409).json({
            ok: false,
            reason: 'device_limit',
            error: `This device has already been used to mark ${sessionLabel(session)} attendance today.`,
          });
        }
        return res.status(409).json({
          ok: false,
          reason: 'already_marked',
          error: `${sessionLabel(session)} attendance for this mobile number is already marked today.`,
        });
      }
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

app.post('/api/admin/login', (req, res) => {
  if (req.body?.password === ADMIN_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ ok: false, error: 'Wrong password' });
});

app.get('/api/admin/settings', requireAdmin, async (req, res, next) => {
  try {
    res.json(await getSettings());
  } catch (err) {
    next(err);
  }
});

app.post('/api/admin/settings', requireAdmin, async (req, res, next) => {
  try {
    const {
      venue_lat, venue_lng, radius_m,
      morning_start, morning_end, afternoon_start, afternoon_end,
      venue_label,
    } = req.body || {};
    if (
      ![venue_lat, venue_lng, radius_m].every(Number.isFinite) ||
      !morning_start || !morning_end || !afternoon_start || !afternoon_end ||
      !venue_label?.trim()
    ) {
      return res
        .status(400)
        .json({ ok: false, error: 'All venue settings are required.' });
    }
    await pool.query(
      `UPDATE settings SET venue_lat=$1, venue_lng=$2, radius_m=$3,
         morning_start=$4, morning_end=$5, afternoon_start=$6, afternoon_end=$7,
         venue_label=$8
       WHERE id = 1`,
      [venue_lat, venue_lng, radius_m, morning_start, morning_end, afternoon_start, afternoon_end, venue_label.trim()]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.get('/api/admin/attendance', requireAdmin, async (req, res, next) => {
  try {
    const date = req.query.date || todayStr();
    const rows = (
      await pool.query(
        `SELECT id, name, branch, mobile, session,
                timestamp, distance_m, device_id, ip_address
         FROM attendance
         WHERE date = $1 ORDER BY timestamp`,
        [date]
      )
    ).rows;
    res.json({
      ok: true,
      date,
      present: rows,
      presentCount: rows.length,
      branchCount: new Set(rows.map((r) => r.branch)).size,
    });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/admin/attendance/:id', requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM attendance WHERE id = $1', [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ ok: false, error: 'Record not found.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.get('/api/admin/attendance/export', requireAdmin, async (req, res, next) => {
  try {
    const date = req.query.date || todayStr();
    const rows = (
      await pool.query(
        `SELECT name, branch, mobile, session, timestamp,
                ROUND(distance_m::numeric, 1) AS distance_m, device_id, ip_address
         FROM attendance WHERE date = $1 ORDER BY timestamp`,
        [date]
      )
    ).rows;
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [
      'name,branch,mobile,session,timestamp,distance_m,device_id,ip_address',
      ...rows.map((r) =>
        [r.name, r.branch, r.mobile, r.session, r.timestamp.toISOString(), r.distance_m, r.device_id, r.ip_address]
          .map(esc)
          .join(',')
      ),
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="attendance_${date}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

// Admin: view device usage for a date (debug/audit endpoint)
app.get('/api/admin/devices', requireAdmin, async (req, res, next) => {
  try {
    const date = req.query.date || todayStr();
    const rows = (
      await pool.query(
        `SELECT device_id, session, mobile, marked_at
         FROM device_limits WHERE date = $1 ORDER BY marked_at`,
        [date]
      )
    ).rows;
    res.json({ ok: true, date, devices: rows, count: rows.length });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

app.use((err, _req, res, _next) => {
  console.error('Unhandled request error:', err);
  res.status(500).json({ ok: false, error: 'Server error. Please try again.' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

initializeDatabase()
  .then(() =>
    app.listen(PORT, () =>
      console.log(`Attendance server running on http://localhost:${PORT}`)
    )
  )
  .catch((err) => {
    console.error('Database startup failed:', err);
    process.exit(1);
  });
