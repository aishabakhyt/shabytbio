require('dotenv').config();
const { connectMongo } = require('../services/mongo');
const { listFeedback } = require('../services/feedback');

// Prints submitted student feedback/bug reports, newest first -- the "I see
// it" half of the feedback feature (services/feedback.js, routes/feedback.js,
// and the in-app "Feedback" nav button). Run this from your own machine
// (needs a real network path to MongoDB Atlas, which no Claude sandbox has):
//   node scripts/view-feedback.js
//
// Not a public route: reading feedback happens through GET /api/feedback in
// the running app too, but that's dev-gated (isDevUser) so a student can
// never see other students' reports. This script is the other, simpler way
// to check submissions without having to sign in as the dev account.

async function main() {
  const items = await listFeedback();
  if (items.length === 0) {
    console.log('No feedback submitted yet.');
    return;
  }
  console.log(`${items.length} feedback item(s), newest first:\n`);
  for (const item of items) {
    console.log(`#${item.id} -- ${item.createdAt}`);
    console.log(`  from: ${item.userEmail || `user ${item.userId}`}`);
    if (item.page) console.log(`  page: ${item.page}`);
    console.log(`  ${item.message}`);
    console.log('');
  }
}

main()
  .catch(err => { console.error('Failed to load feedback:', err.message); process.exitCode = 1; })
  .finally(() => process.exit());
