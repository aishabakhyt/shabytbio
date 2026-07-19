// Looks up real, existing YouTube videos for a topic instead of trying to
// generate video content — generating video is out of reach for a free-tier
// AI project, but linking to genuinely relevant existing videos is free and
// realistic via YouTube's own Data API.
const YOUTUBE_SEARCH_ENDPOINT = 'https://www.googleapis.com/youtube/v3/search';
const MAX_RESULTS = 3;

// Cache video search results the same way we cache Gemini results — the
// same topic query will very often repeat across students studying the same
// lesson, and YouTube's free quota (10,000 units/day, 100 units per search)
// is worth conserving.
const cache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — video relevance doesn't go stale fast

async function searchVideos(query) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    throw new Error('YOUTUBE_API_KEY is not set — add a free YouTube Data API v3 key to your .env file to enable video suggestions.');
  }
  if (!query || !query.trim()) {
    throw new Error('No search query provided.');
  }

  const cacheKey = query.trim().toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.videos;
  }

  const url = new URL(YOUTUBE_SEARCH_ENDPOINT);
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('type', 'video');
  url.searchParams.set('maxResults', String(MAX_RESULTS));
  url.searchParams.set('q', query);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('safeSearch', 'strict');
  url.searchParams.set('videoEmbeddable', 'true');
  url.searchParams.set('relevanceLanguage', 'en');

  const response = await fetch(url.toString());
  const data = await response.json();

  if (!response.ok) {
    const message = (data.error && data.error.message) || `YouTube API error ${response.status}`;
    throw new Error(message);
  }

  const videos = (data.items || [])
    .filter(item => item.id && item.id.videoId)
    .map(item => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      channelTitle: item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails && (item.snippet.thumbnails.medium || item.snippet.thumbnails.default).url,
    }));

  cache.set(cacheKey, { videos, at: Date.now() });
  return videos;
}

module.exports = { searchVideos };
