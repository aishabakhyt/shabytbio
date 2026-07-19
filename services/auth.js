const { OAuth2Client } = require('google-auth-library');

// Only needs the Client ID (no secret) — we're verifying an ID token that
// Google Identity Services already issued client-side, not doing a server
// redirect/code-exchange flow.
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Verifies a Google ID token (the `credential` string from the Sign In With
// Google button) and returns the payload if valid, or throws if not.
async function verifyGoogleIdToken(idToken) {
  if (!process.env.GOOGLE_CLIENT_ID) {
    throw new Error('GOOGLE_CLIENT_ID is not set in .env — Google sign-in is not configured.');
  }
  const ticket = await client.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload || !payload.sub) {
    throw new Error('Invalid Google token payload.');
  }
  return {
    googleId: payload.sub,
    email: payload.email,
    name: payload.name || payload.email,
    picture: payload.picture || '',
  };
}

module.exports = { verifyGoogleIdToken };
