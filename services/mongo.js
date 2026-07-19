const { MongoClient } = require('mongodb');

// A MongoClient is meant to be created once and reused for the lifetime of
// the process (it pools connections internally) — NOT reconnected per
// request. This module lazily connects on first use and hands back the same
// `db` handle to every caller after that.
let client = null;
let db = null;
let connectingPromise = null;

function connectMongo() {
  if (db) return Promise.resolve(db);
  if (connectingPromise) return connectingPromise;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    return Promise.reject(new Error(
      'MONGODB_URI is not set — add a free MongoDB Atlas connection string to your .env file.'
    ));
  }

  connectingPromise = (async () => {
    client = new MongoClient(uri);
    await client.connect();
    db = client.db(process.env.MONGODB_DB_NAME || 'shabytbio');
    return db;
  })().catch(err => {
    // Let the next call retry instead of permanently caching a failed connection.
    connectingPromise = null;
    throw err;
  });

  return connectingPromise;
}

module.exports = { connectMongo };
