require('dotenv').config();
const { searchVideos } = require('../services/youtube');

// Quick standalone check: does YOUTUBE_API_KEY in your .env actually work?
// Run with: node scripts/test-youtube.js

searchVideos('mitosis stages biology')
  .then(videos => {
    if (!videos.length) {
      console.log('⚠️  Connected fine, but got zero results — try a different query to double check.');
      return;
    }
    console.log(`✅ YOUTUBE_API_KEY works — found ${videos.length} video(s):`);
    videos.forEach(v => console.log(`   - ${v.title} (${v.channelTitle})`));
  })
  .catch(err => {
    console.log('❌ Failed:', err.message);
  });
