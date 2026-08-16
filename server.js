const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

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
const FACE_MATCH_THRESHOLD = parseFloat(process.env.FACE_MATCH_THRESHOLD || '0.6');

if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD) {
  throw new Error('ADMIN_PASSWORD must be set when running in production.');
}
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL must be set to a PostgreSQL connection URL in process environment or .env file.');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

// Increased limit for base64 photo uploads
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

// ---------------------------------------------------------------------------
// Face matching — Euclidean distance on 128-dim descriptors
// ---------------------------------------------------------------------------

function euclideanDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] - b[i]) ** 2;
  }
  return Math.sqrt(sum);
}

async function findBestMatch(descriptor) {
  const { rows } = await pool.query(
    'SELECT id, name, branch, mobile, email, face_descriptor, photo FROM students'
  );
  let best = null;
  let bestDist = Infinity;
  for (const row of rows) {
    const dist = euclideanDistance(descriptor, row.face_descriptor);
    if (dist < bestDist) {
      bestDist = dist;
      best = row;
    }
  }
  if (best && bestDist <= FACE_MATCH_THRESHOLD) {
    return {
      student: {
        id: best.id,
        name: best.name,
        branch: best.branch,
        mobile: best.mobile,
        email: best.email,
        photo: best.photo,
      },
      distance: bestDist,
      confidence: Math.max(0, Math.round((1 - bestDist / FACE_MATCH_THRESHOLD) * 100)),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Database initialisation
// ---------------------------------------------------------------------------

async function initializeDatabase() {
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

    CREATE TABLE IF NOT EXISTS students (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      branch TEXT NOT NULL,
      mobile TEXT NOT NULL UNIQUE,
      email TEXT,
      photo TEXT,
      face_descriptor DOUBLE PRECISION[] NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS attendance (
      id BIGSERIAL PRIMARY KEY,
      student_id BIGINT REFERENCES students(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      branch TEXT NOT NULL,
      mobile TEXT NOT NULL,
      date TEXT NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      accuracy DOUBLE PRECISION,
      distance_m DOUBLE PRECISION,
      device_id TEXT,
      session TEXT NOT NULL DEFAULT 'morning',
      match_confidence DOUBLE PRECISION
    );

    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS student_id BIGINT REFERENCES students(id) ON DELETE CASCADE;
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS match_confidence DOUBLE PRECISION;

    CREATE INDEX IF NOT EXISTS idx_att_date ON attendance(date);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_att_student_date_session
      ON attendance(student_id, date, session);
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

// Status — venue info, session, registered count
app.get('/api/status', async (req, res, next) => {
  try {
    const venue = await getSettings();
    const session = activeSession(venue);
    const studentCount = (await pool.query('SELECT COUNT(*) FROM students')).rows[0].count;
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
        message: `Attendance: ${venue.morning_start}–${venue.morning_end} (before lunch) · ${venue.afternoon_start}–${venue.afternoon_end} (after lunch).`,
      },
      registeredStudents: parseInt(studentCount, 10),
    });
  } catch (err) {
    next(err);
  }
});

// Register — save face + student details
app.post('/api/register', async (req, res, next) => {
  try {
    let { name, branch, mobile, email, photo, descriptor, lat, lng, accuracy } =
      req.body || {};
    name = typeof name === 'string' ? name.trim() : '';
    branch = typeof branch === 'string' ? branch.trim() : '';
    email = typeof email === 'string' ? email.trim() : '';
    const mobileDigits = normalizeMobile(mobile);

    if (!name || !branch || !mobileDigits) {
      return res
        .status(400)
        .json({ ok: false, error: 'Name, branch, and mobile number are required.' });
    }
    if (!isValidMobile(mobileDigits)) {
      return res
        .status(400)
        .json({ ok: false, error: 'Enter a valid 10-digit mobile number.' });
    }
    if (!descriptor || !Array.isArray(descriptor) || descriptor.length !== 128) {
      return res.status(400).json({
        ok: false,
        error: 'A valid face scan is required. Ensure your face is clearly visible.',
      });
    }
    if (!photo || typeof photo !== 'string') {
      return res.status(400).json({ ok: false, error: 'Photo capture is required.' });
    }

    // Reject if face already matches an existing student
    const existingMatch = await findBestMatch(descriptor);
    if (existingMatch) {
      // A weak connection can lose the success response. Treat a retry for the
      // same mobile and face as success, so one registration attempt is safe.
      if (existingMatch.student.mobile === mobileDigits) {
        return res.json({
          ok: true,
          alreadyRegistered: true,
          message: `${name} is already registered. You can now check in with your face.`,
        });
      }
      return res.status(409).json({
        ok: false,
        error: `This face is already registered under "${existingMatch.student.name}" (${existingMatch.student.branch}). Contact admin if this is wrong.`,
      });
    }

    // Geofence check (if location provided)
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      const venue = await getSettings();
      const dist = distanceMeters(lat, lng, venue.venue_lat, venue.venue_lng);
      if (dist > venue.radius_m) {
        return res.status(403).json({
          ok: false,
          error: `You are ${Math.round(dist)}m from the venue. Registration must be done within ${venue.radius_m}m.`,
        });
      }
    }

    try {
      await pool.query(
        `INSERT INTO students (name, branch, mobile, email, photo, face_descriptor)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [name, branch, mobileDigits, email || null, photo, descriptor]
      );
    } catch (err) {
      if (err.code === '23505') {
        const saved = (await pool.query(
          'SELECT name, face_descriptor FROM students WHERE mobile = $1',
          [mobileDigits]
        )).rows[0];
        if (saved && euclideanDistance(descriptor, saved.face_descriptor) <= FACE_MATCH_THRESHOLD) {
          return res.json({
            ok: true,
            alreadyRegistered: true,
            message: `${saved.name} is already registered. You can now check in with your face.`,
          });
        }
        return res
          .status(409)
          .json({ ok: false, error: 'This mobile number is already registered.' });
      }
      throw err;
    }

    res.json({
      ok: true,
      message: `${name} registered successfully! You can now check in with your face.`,
    });
  } catch (err) {
    next(err);
  }
});

// Recognise — match face → mark attendance
app.post('/api/recognize', async (req, res, next) => {
  try {
    const { descriptor, lat, lng, accuracy, deviceId } = req.body || {};

    if (!descriptor || !Array.isArray(descriptor) || descriptor.length !== 128) {
      return res
        .status(400)
        .json({ ok: false, error: 'A valid face scan is required.' });
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res
        .status(400)
        .json({ ok: false, error: 'Location is required to mark attendance.' });
    }

    // Match
    const match = await findBestMatch(descriptor);
    if (!match) {
      return res.status(404).json({
        ok: false,
        error: "Face not recognised. If you haven't registered yet, switch to the Register tab first.",
      });
    }

    // Geofence
    const venue = await getSettings();
    const dist = distanceMeters(lat, lng, venue.venue_lat, venue.venue_lng);
    if (dist > venue.radius_m) {
      return res.status(403).json({
        ok: false,
        reason: 'outside_venue',
        error: `You are ${Math.round(dist)}m away. Must be within ${venue.radius_m}m of the venue.`,
        student: { name: match.student.name, branch: match.student.branch },
      });
    }

    // Session check
    const session = activeSession(venue);
    if (!session) {
      return res.status(403).json({
        ok: false,
        reason: 'attendance_closed',
        error: `Attendance is closed. Windows: ${venue.morning_start}–${venue.morning_end} and ${venue.afternoon_start}–${venue.afternoon_end}.`,
        student: { name: match.student.name, branch: match.student.branch },
      });
    }

    const date = todayStr();

    try {
      await pool.query(
        `INSERT INTO attendance
           (student_id, name, branch, mobile, date, timestamp,
            lat, lng, accuracy, distance_m, device_id, session, match_confidence)
         VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7,$8,$9,$10,$11,$12)`,
        [
          match.student.id,
          match.student.name,
          match.student.branch,
          match.student.mobile,
          date,
          lat,
          lng,
          Number.isFinite(accuracy) ? accuracy : null,
          dist,
          deviceId || null,
          session,
          match.confidence,
        ]
      );
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({
          ok: false,
          reason: 'already_marked',
          error: `${sessionLabel(session)} attendance already marked today.`,
          student: {
            name: match.student.name,
            branch: match.student.branch,
            photo: match.student.photo,
          },
        });
      }
      throw err;
    }

    res.json({
      ok: true,
      message: `${sessionLabel(session)} attendance marked!`,
      student: {
        name: match.student.name,
        branch: match.student.branch,
        photo: match.student.photo,
      },
      confidence: match.confidence,
      distance: Math.round(dist),
    });
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
        `SELECT a.id, a.student_id, a.name, a.branch, a.mobile, a.session,
                a.timestamp, a.distance_m, a.match_confidence, s.photo
         FROM attendance a
         LEFT JOIN students s ON a.student_id = s.id
         WHERE a.date = $1 ORDER BY a.timestamp`,
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

app.get('/api/admin/students', requireAdmin, async (req, res, next) => {
  try {
    const rows = (
      await pool.query(
        `SELECT id, name, branch, mobile, email, photo, registered_at
         FROM students ORDER BY registered_at DESC`
      )
    ).rows;
    res.json({ ok: true, students: rows, count: rows.length });
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

app.delete('/api/admin/students/:id', requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM students WHERE id = $1', [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ ok: false, error: 'Student not found.' });
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
                ROUND(distance_m::numeric, 1) AS distance_m, match_confidence
         FROM attendance WHERE date = $1 ORDER BY timestamp`,
        [date]
      )
    ).rows;
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [
      'name,branch,mobile,session,timestamp,distance_m,match_confidence',
      ...rows.map((r) =>
        [r.name, r.branch, r.mobile, r.session, r.timestamp.toISOString(), r.distance_m, r.match_confidence]
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
      console.log(`Face attendance server running on http://localhost:${PORT}`)
    )
  )
  .catch((err) => {
    console.error('Database startup failed:', err);
    process.exit(1);
  });
