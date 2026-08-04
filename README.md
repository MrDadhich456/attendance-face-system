# Induction Attendance System with AI Face Recognition

Geofenced, AI face-matching attendance system for student induction programs. 

## Features
1. **First-Time Face Registration**: Students fill in their name, branch, mobile, and capture a selfie photo. Browser extracts a 128-dimensional facial descriptor vector (using `face-api.js`) and stores it with the student profile.
2. **Subsequent Face Recognition Check-In**: Students simply open the camera, align their face, and tap "Scan Face & Check In". The system calculates Euclidean distance between the live descriptor and stored face descriptors. Upon a match, the student's name, branch, and photo are displayed, and attendance is marked automatically!
3. **Geofencing**: Server-side GPS verification (Haversine formula) ensures students are within the specified venue radius.
4. **Session Management**: Supports "Before lunch" (morning) and "After lunch" (afternoon) attendance sessions per day.
5. **Admin Dashboard**: Password-protected dashboard to manage venue geofence, view/delete registered face profiles, monitor check-ins, and export CSV attendance logs.

## Setup & Running Locally

1. Install dependencies:
```bash
npm install
```

2. Run local server:
```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/attendance npm start
```

3. Open in browser:
- `http://localhost:3000/` — Student Check-In & Face Registration Page
- `http://localhost:3000/admin.html` — Admin Dashboard (Default password: `changeme123`)

## Deployment (Render.com / PostgreSQL)

Environment variables required on your host:
- `NODE_ENV=production`
- `ADMIN_PASSWORD=your_secure_password`
- `DATABASE_URL=postgresql://user:pass@host:5432/database`
- `FACE_MATCH_THRESHOLD=0.6` (Euclidean distance threshold; smaller is stricter, default 0.6)
