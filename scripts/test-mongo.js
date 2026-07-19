require('dotenv').config();
const { MongoClient } = require('mongodb');

// Quick standalone check: does the MONGODB_URI in your .env actually work?
// Run with: node scripts/test-mongo.js

const uri = process.env.MONGODB_URI;

if (!uri) {
  console.log('❌ MONGODB_URI is not set in your .env file.');
  process.exit(1);
}

// Print the URI with the password hidden, so you can eyeball the shape of it
// (right username, right cluster host, no stray characters) without leaking
// the password in your terminal history/screenshots.
const masked = uri.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:****@');
console.log('Testing connection with:', masked);

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });

client.connect()
  .then(async () => {
    console.log('✅ Connected successfully — the password and connection string are correct.');
    await client.db(process.env.MONGODB_DB_NAME || 'shabytbio').command({ ping: 1 });
    console.log('✅ Ping succeeded — the database is reachable and working.');
    await client.close();
    process.exit(0);
  })
  .catch(err => {
    console.log('❌ Connection failed:', err.message);
    if (err.message.includes('bad auth') || err.message.includes('Authentication failed')) {
      console.log('   → This means the username/password in MONGODB_URI is wrong. Re-check the password.');
    } else if (err.message.includes('ETIMEDOUT') || err.message.includes('timed out') || err.message.includes('SSL') || err.message.includes('TLS')) {
      console.log('   → This looks like a network/firewall/TLS issue, not a password issue.');
      console.log('   → Double check Network Access in Atlas has 0.0.0.0/0 set to Active.');
    }
    process.exit(1);
  });
