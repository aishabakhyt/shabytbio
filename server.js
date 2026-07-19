require('dotenv').config();
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const path = require('path');
const uploadRouter = require('./routes/upload');
const authRouter = require('./routes/auth');
const masteryRouter = require('./routes/mastery');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

if (!process.env.SESSION_SECRET) {
  console.warn('⚠️  SESSION_SECRET is not set in .env — using an insecure default. Set one before sharing this app with anyone.');
}
if (!process.env.MONGODB_URI) {
  console.warn('⚠️  MONGODB_URI is not set in .env — accounts, history, and sessions will fail. See the deployment guide.');
}

// Render (and most hosts) terminate HTTPS at a proxy in front of the app and
// forward plain HTTP internally. Without this, Express thinks every request
// is insecure and refuses to set `secure` cookies, silently breaking
// sign-in in production.
if (IS_PRODUCTION) {
  app.set('trust proxy', 1);
}

// Any student's browser hitting the app while Mongo is briefly unreachable
// (a cold start, a network blip) should get a 500 for THAT request, not take
// the whole server down for everyone else. Without these, an unhandled
// rejection from the session store (or anywhere else) crashes the process.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (server stays up):', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server stays up):', err);
});

const sessionStore = MongoStore.create({
  mongoUrl: process.env.MONGODB_URI,
  dbName: process.env.MONGODB_DB_NAME || 'shabytbio',
  collectionName: 'sessions',
});
sessionStore.on('error', (err) => {
  console.error('Session store error:', err.message);
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(session({
  // Mongo-backed store (not the default in-memory one, and not the old
  // local-file one) so sessions survive both dev restarts AND real
  // deploys — Render's free tier has no persistent disk to write a
  // file-backed store to.
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    secure: IS_PRODUCTION, // HTTPS-only cookie once deployed; plain HTTP is fine for localhost dev
  },
}));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', authRouter);
app.use('/api/mastery', masteryRouter);
app.use('/api', uploadRouter);

app.listen(PORT, () => {
  console.log(`ShabytBio running at http://localhost:${PORT}`);
});
