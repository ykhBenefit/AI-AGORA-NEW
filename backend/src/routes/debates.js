const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const { requireAgent, optionalAgent } = require('../middleware/auth');

const router = express.Router();

// JSON 파싱 안전 처리 (이미 파싱된 데이터도 처리)
function safeParse(val) {
  if (val === null || val === undefined) return val;
  if (typeof val !== 'string') return val; // 이미 객체/배열이면 그대로
  try { return JSON.parse(val); } catch (e) { return val; }
}

const CATEGORIES = {
  general: { emoji: '💬', label: '일반 토론' },
  science: { emoji: '🔬', label: '과학&기술' },
  art:     { emoji: '🎨', label: '예술&문화' },
  politics:{ emoji: '💼', label: '정치&경제' },
  news:    { emoji: '📰', label: '시사&연예' },
  gaming:  { emoji: '🎮', label: '게임' }
};

/**
 * GET /api/v1/debates
 * List debates with optional filters
 */
router.get('/', (req, res) => {
  const { category, type, sort, limit: rawLimit, offset: rawOffset, active } = req.query;
  const limit = Math.min(parseInt(rawLimit) || 50, 200);
  const offset = parseInt(rawOffset) || 0;

  let where = [];
  let params = [];

  if (category && CATEGORIES[category]) {
    where.push('category = ?');
    params.push(category);
  }
  if (type === 'debate' || type === 'vote') {
    where.push('type = ?');
    params.push(type);
  }
  if (active !== undefined) {
    where.push('is_active = ?');
    params.push(active === 'true' ? 1 : 0);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  let orderBy = 'created_at DESC';
  if (sort === 'activity') orderBy = 'activity_level DESC, message_count DESC';
  else if (sort === 'popular') orderBy = 'upvotes DESC, message_count DESC';
  else if (sort === 'oldest') orderBy = 'created_at ASC';

  const debates = db.prepare(`
    SELECT * FROM debates ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = db.prepare(`SELECT COUNT(*) as count FROM debates ${whereClause}`).get(...params);

  // Parse JSON fields
  debates.forEach(d => {
    d.vote_options = safeParse(d.vote_options);
    d.votes = safeParse(d.votes);
  });

  res.json({ debates, total: total.count, limit, offset });
});

/**
 * POST /api/v1/debates
 * Create a new debate (agents or humans via frontend)
 */
router.post('/', optionalAgent, (req, res) => {
  const { topic, type, category, vote_options, grid_position } = req.body;

  if (!topic || topic.trim().length < 5) {
    return res.status(400).json({ error: 'Topic must be at least 5 characters' });
  }

  if (!type || !['debate', 'vote'].includes(type)) {
    return res.status(400).json({ error: 'Type must be "debate" or "vote"' });
  }

  if (!category || !CATEGORIES[category]) {
    return res.status(400).json({
      error: 'Invalid category',
      valid_categories: Object.keys(CATEGORIES)
    });
  }

  if (type === 'vote') {
    if (!vote_options || !Array.isArray(vote_options) || vote_options.length < 2) {
      return res.status(400).json({ error: 'Vote type requires at least 2 options' });
    }
  }

  // Find available grid position
  const usedPositions = db.prepare(
    'SELECT grid_position FROM debates WHERE is_active = 1 AND grid_position IS NOT NULL'
  ).all().map(r => r.grid_position);

  const gridSize = parseInt(process.env.DEFAULT_GRID_SIZE) || 400;
  let gridPos = null;

  // 클라이언트가 grid_position을 지정한 경우 해당 위치 사용
  if (grid_position !== undefined && grid_position !== null) {
    const requestedPos = parseInt(grid_position);
    if (requestedPos >= 0 && requestedPos < gridSize && !usedPositions.includes(requestedPos)) {
      gridPos = requestedPos;
    } else if (usedPositions.includes(requestedPos)) {
      return res.status(409).json({ error: 'Grid position already occupied' });
    }
  }

  // 지정하지 않은 경우 자동 배정
  if (gridPos === null) {
    for (let i = 0; i < gridSize; i++) {
      if (!usedPositions.includes(i)) {
        gridPos = i;
        break;
      }
    }
  }

  const id = uuidv4();
  const now = Date.now();

  // Initialize vote tracking
  const initialVotes = {};
  if (type === 'vote' && vote_options) {
    vote_options.forEach(opt => { initialVotes[opt] = 0; });
  }

  const creatorType = req.agent ? 'agent' : 'human';
  const creatorName = req.agent ? req.agent.name : (req.body.creator_name || 'anonymous');

  db.prepare(`
    INSERT INTO debates (id, topic, type, category, vote_options, votes, activity_level, grid_position, creator_type, creator_name, created_at, is_active, message_count, bot_count, upvotes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, topic.trim(), type, category,
    type === 'vote' ? JSON.stringify(vote_options) : null,
    JSON.stringify(initialVotes),
    1, gridPos, creatorType, creatorName, now,
    1, 0, 0, 0
  );

  res.status(201).json({
    success: true,
    message: 'Debate created! 🏛️',
    debate: {
      id, topic: topic.trim(), type, category,
      grid_position: gridPos,
      vote_options: type === 'vote' ? vote_options : undefined,
      created_at: now
    }
  });
});

/**
 * GET /api/v1/debates/:id
 * Get debate details
 */
router.get('/:id', (req, res) => {
  const debate = db.prepare('SELECT * FROM debates WHERE id = ?').get(req.params.id);

  if (!debate) {
    return res.status(404).json({ error: 'Debate not found' });
  }

  debate.vote_options = safeParse(debate.vote_options);
  debate.votes = safeParse(debate.votes);

  // Get recent messages
  const messages = db.prepare(`
    SELECT m.*, a.personality, a.is_verified
    FROM messages m
    JOIN agents a ON m.agent_id = a.id
    WHERE m.debate_id = ? AND m.is_deleted = 0
    ORDER BY m.created_at DESC
    LIMIT 100
  `).all(req.params.id);

  // Get participating agents
  const participants = db.prepare(`
    SELECT DISTINCT a.id, a.name, a.personality, a.is_verified
    FROM messages m
    JOIN agents a ON m.agent_id = a.id
    WHERE m.debate_id = ? AND m.is_deleted = 0
  `).all(req.params.id);

  // Check best debate criteria
  const isBest = debate.upvotes >= 30 && debate.message_count >= 50 && debate.activity_level >= 8;

  res.json({
    ...debate,
    messages: messages.reverse(),
    participants,
    is_best: isBest
  });
});

/**
 * GET /api/v1/debates/grid/state
 * Get grid visualization data (all active debates + positions)
 */
router.get('/grid/state', (req, res) => {
  const debates = db.prepare(`
    SELECT id, topic, type, category, activity_level, bot_count, message_count, upvotes, grid_position, created_at
    FROM debates
    WHERE is_active = 1
    ORDER BY activity_level DESC
  `).all();

  const gridSize = parseInt(process.env.DEFAULT_GRID_SIZE) || 400;

  res.json({ debates, grid_size: gridSize, categories: CATEGORIES });
});

/**
 * GET /api/v1/debates/search
 * Search debates by keyword
 */
router.get('/search/query', (req, res) => {
  const { q, limit: rawLimit } = req.query;
  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: 'Search query must be at least 2 characters' });
  }

  const limit = Math.min(parseInt(rawLimit) || 20, 50);
  const searchTerm = `%${q.trim()}%`;

  const results = db.prepare(`
    SELECT * FROM debates
    WHERE topic LIKE ? AND is_active = 1
    ORDER BY activity_level DESC
    LIMIT ?
  `).all(searchTerm, limit);

  results.forEach(d => {
    d.vote_options = safeParse(d.vote_options);
    d.votes = safeParse(d.votes);
  });

  res.json({ results, query: q.trim() });
});

module.exports = router;
